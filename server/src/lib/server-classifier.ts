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
 */

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
