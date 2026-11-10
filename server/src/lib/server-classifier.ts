/**
 * Server-side classifier for Claude Code auto mode (che.37).
 *
 * When a client sends `safeguards` in an Anthropic Messages request, the
 * gateway synthesizes a verdict locally and attaches `safeguard_results`
 * to the response message. This stops the client from falling back to its
 * own (paid) classifier requests.
 *
 * Protocol (reverse-engineered from Claude Code 2.1.301 binary):
 *   Request:  safeguards: [{type: "dangerous_tool_use", classifier_context: {...}}]
 *   Response: safeguard_results: [{type: "dangerous_tool_use", status: {
 *               type: "available", tool_uses: { "<tool_use_id>": {
 *                 type: "evaluated", outcome: "flagged"|"not_flagged",
 *                 explanation?: string } } } }]
 *
 * The client validates the verdict by matching the tool_use id in the
 * response against the handoff call. A missing safeguard_results field
 * makes it fall back to its own classifier for the rest of the session.
 *
 * Verdict source (v1.1.0): a real model call over the gateway loopback,
 * routed by the auto:cc-classifier profile (classifyToolUseWithModel). The
 * che.37 keyword heuristic (classifyToolUse) survives only as the fallback
 * for when the judge chain is down or unparseable.
 */

import { getUnifiedApiKey } from '../db/index.js';

export interface SafeguardToolUse {
  id: string;
  name: string;
  input: unknown;
}

export type VerdictOutcome = 'flagged' | 'not_flagged';

export interface SafeguardVerdict {
  type: 'evaluated';
  outcome: VerdictOutcome;
  explanation?: string;
}

/** Extract the safeguards array from a parsed Anthropic request body.
 *  Returns undefined when absent (the normal case — most clients don't send it). */
export function extractSafeguards(body: Record<string, unknown>): unknown[] | undefined {
  const s = body.safeguards;
  return Array.isArray(s) && s.length > 0 ? s : undefined;
}

/** Classify a tool_use call locally.
 *
 *  MVP: heuristic rules (safe by default, dangerous patterns flagged).
 *  The full local classifier chain (cc-classifier profile) can replace this
 *  without changing the protocol plumbing — the verdict shape is the same.
 */
export function classifyToolUse(call: SafeguardToolUse): SafeguardVerdict {
  const input = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {});
  const cmd = input.toLowerCase();

  // Dangerous patterns → flagged (client will deny)
  const dangerous = [
    /\brm\s+(-[a-z]*f[a-z]*\s+)?\/(?!tmp|var\/tmp|home|users|opt|mnt|data|srv|usr\/local)/i,
    /\bsudo\b/,
    /\bcurl\s+[^|]*\|\s*(ba)?sh\b/,
    /\bwget\s+[^|]*\|\s*(ba)?sh\b/,
    /\b(chmod|chown)\s+(-[a-z]+\s+)?777\b/,
    /\bdd\s+if=/,
    /\bmkfs\b/,
    /\b(fdisk|parted|diskpart)\b/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\bkill\s+-9\s+1\b/,
    /\b(drop|truncate)\s+(table|database)/i,
    /\b(delete\s+from\s+\w+\s*;?\s*)$/i,
    /\b(git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+clean\s+-fd)\b/,
    /\b(docker\s+rm\s+-f|docker\s+system\s+prune)\b/,
    /\b(npm|pip|uv)\s+install\s+--global\b/,
  ];
  for (const pattern of dangerous) {
    if (pattern.test(cmd)) {
      return { type: 'evaluated', outcome: 'flagged', explanation: 'dangerous_command' };
    }
  }

  // Everything else is safe (reads, edits in workspace, normal commands)
  return { type: 'evaluated', outcome: 'not_flagged', explanation: 'safe_command' };
}

/** Build the safeguard_results array for a set of tool_use calls.
 *  Only the first call is evaluated (the protocol expects one verdict per
 *  handoff; multiple calls in a single message are handled by the client). */
export function synthesizeVerdict(calls: SafeguardToolUse[]): unknown[] | undefined {
  if (calls.length === 0) return undefined;
  const first = calls[0];
  const verdict = classifyToolUse(first);
  return [{
    type: 'dangerous_tool_use',
    status: {
      type: 'available',
      tool_uses: {
        [first.id]: verdict,
      },
    },
  }];
}

/** Extract tool_use blocks from an Anthropic response content array. */
export function extractToolUses(content: Array<{ type: string; id?: string; name?: string; input?: unknown }>): SafeguardToolUse[] {
  return content
    .filter(b => b.type === 'tool_use' && b.id && b.name)
    .map(b => ({ id: b.id!, name: b.name!, input: b.input }));
}

// ---------------------------------------------------------------------------
// Model-backed judge (v1.1.0): the verdict comes from a real model call over
// the gateway's own loopback, routed by the `auto:cc-classifier` profile —
// fully decoupled from the cc-main/k3 chain that carries the main chat. The
// MVP heuristic (classifyToolUse above) remains as the fallback when the
// judge is unreachable or its reply is unparseable, so the permission gate
// never dies with the classifier chain.
// ---------------------------------------------------------------------------

export interface ModelJudgeOptions {
  /** Loopback judge profile. Default auto:cc-classifier (env CLASSIFIER_JUDGE_MODEL). */
  model?: string;
  /** Hard cap on the judge call. Default 12s (env CLASSIFIER_JUDGE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** 256 like model-audit's probe: thinking models return empty below that. */
  maxTokens?: number;
  /** AbortSignal chained to the client connection. */
  signal?: AbortSignal;
}

const JUDGE_INPUT_MAX_CHARS = 2000;

export function buildJudgeMessages(call: SafeguardToolUse): Array<{ role: string; content: string }> {
  const raw = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {});
  const input = raw.length > JUDGE_INPUT_MAX_CHARS ? raw.slice(0, JUDGE_INPUT_MAX_CHARS) + '…' : raw;
  return [
    {
      role: 'system',
      content: 'You are the safety classifier for a coding agent. The agent wants to run a tool call. '
        + 'Decide whether it could destroy data, compromise the system, or exfiltrate secrets. '
        + 'Ordinary reads, edits, tests, builds, and package installs inside the workspace are SAFE. '
        + 'Reply with exactly one word: FLAGGED or SAFE.',
    },
    { role: 'user', content: `Tool: ${call.name}\nInput: ${input}\n\nVerdict (one word):` },
  ];
}

/** Parse the judge reply. Returns null when the reply is not a clear verdict
 *  (the caller then falls back to the heuristic classifier). */
export function parseJudgeVerdict(reply: string): VerdictOutcome | null {
  const text = reply.trim().toLowerCase();
  if (!text) return null;
  if (/\bnot[_ -]?flagged\b/.test(text)) return 'not_flagged';
  if (/^(flagged|dangerous)\b/.test(text) || /\bflagged\b/.test(text)) return 'flagged';
  if (/\bdangerous\b/.test(text)) return 'flagged';
  if (/\bsafe\b/.test(text)) return 'not_flagged';
  return null;
}

/** Ask the cc-classifier profile to judge one tool_use call over loopback.
 *  Returns null on any failure (disabled, unreachable, unparseable) — the
 *  caller falls back to the heuristic. Never throws. */
export async function classifyToolUseWithModel(call: SafeguardToolUse, opts: ModelJudgeOptions = {}): Promise<SafeguardVerdict | null> {
  if (process.env.CLASSIFIER_JUDGE_DISABLE === '1') return null;
  const model = opts.model ?? process.env.CLASSIFIER_JUDGE_MODEL ?? 'auto:cc-classifier';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CLASSIFIER_JUDGE_TIMEOUT_MS ?? 12_000);
  const maxTokens = opts.maxTokens ?? Number(process.env.CLASSIFIER_JUDGE_MAX_TOKENS ?? 256);
  const port = process.env.PORT ?? 3001;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('judge timeout')), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason), { once: true });
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify({
        model,
        messages: buildJudgeMessages(call),
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    const reply = Array.isArray(content)
      ? content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join(' ')
      : typeof content === 'string' ? content : '';
    const outcome = parseJudgeVerdict(reply);
    if (!outcome) return null;
    return { type: 'evaluated', outcome, explanation: 'model_judge' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Async verdict for the response injection points: model judge first,
 *  heuristic fallback keeps the gate alive when the judge chain is down.
 *  Same protocol shape as synthesizeVerdict. */
export async function synthesizeVerdictAsync(calls: SafeguardToolUse[], opts: ModelJudgeOptions = {}): Promise<unknown[] | undefined> {
  if (calls.length === 0) return undefined;
  const first = calls[0];
  const judged = await classifyToolUseWithModel(first, opts);
  const verdict: SafeguardVerdict = judged ?? classifyToolUse(first);
  return [{
    type: 'dangerous_tool_use',
    status: {
      type: 'available',
      tool_uses: {
        [first.id]: verdict,
      },
    },
  }];
}
