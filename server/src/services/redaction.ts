import { getSetting, setSetting } from '../db/index.js';
import { maskMessages, restoreContent, StreamRestorer } from '../lib/redact/messages.js';
import { restoreText } from '../lib/redact/mask.js';
import type { RuleOptions } from '../lib/redact/rules.js';
import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from '@freellmapi/shared/types.js';
import type { BaseProvider } from '../providers/base.js';
import type { QuotaObservationContext } from './provider-quota.js';
import type { CompletionOptions } from '../providers/base.js';

// Local privacy redaction service (Magpie alignment, P1 = rule layer only).
//
// Master switch defaults ON (privacy by default); per-category toggles default
// on when the master is on. Settings-table values win (dashboard, no restart),
// then env, then the default — same pattern as isCacheEnabled() in cache.ts.

export const REDACT_ENABLED_SETTING = 'redact_enabled';
export const REDACT_SECRETS_SETTING = 'redact_secrets';
export const REDACT_PERSONAL_SETTING = 'redact_personal';

function flag(settingKey: string, envKey: string, dflt: boolean): boolean {
  const stored = getSetting(settingKey);
  if (stored !== undefined && stored.trim() !== '') {
    return /^(1|true|on|yes)$/i.test(stored.trim());
  }
  const env = process.env[envKey];
  if (env !== undefined && env.trim() !== '') {
    return /^(1|true|on|yes)$/i.test(env.trim());
  }
  return dflt;
}

/** Master switch. Default ON (privacy by default): prompts are redacted before
 *  reaching any upstream unless the operator explicitly turns it off. */
export function isRedactEnabled(): boolean {
  return flag(REDACT_ENABLED_SETTING, 'REDACT_ENABLED', true);
}

/** Current rule options. Secrets and personal each default ON when the master
 *  switch is on (you opted into redaction; opting OUT of a category is the
 *  explicit act). */
export function redactOptions(): RuleOptions {
  return {
    secrets: flag(REDACT_SECRETS_SETTING, 'REDACT_SECRETS', true),
    personal: flag(REDACT_PERSONAL_SETTING, 'REDACT_PERSONAL', true),
  };
}

function active(): boolean {
  return isRedactEnabled();
}

/** Mask the final outbound messages before they reach the provider. No-op when
 *  redaction is off (returns the SAME array reference so downstream identity
 *  checks and caches see no change). */
export function maskOutbound(messages: ChatMessage[]): ChatMessage[] {
  if (!active()) return messages;
  return maskMessages(messages, redactOptions());
}

/** Restore placeholders in tool arguments as TEXT, never by parsing and
 *  re-serializing JSON: an incomplete/streaming argument must remain unchanged
 *  except for the placeholder itself. Tool ids and names are protocol data. */
function restoreToolCalls<T extends { function?: { arguments?: string } }>(calls: T[] | undefined): T[] | undefined {
  return calls?.map(call => ({
    ...call,
    ...(call.function && typeof call.function.arguments === 'string' ? {
      function: { ...call.function, arguments: restoreText(call.function.arguments) },
    } : {}),
  }));
}

/** Restore placeholders in a non-streaming chat completion response. */
export function restoreResponse<T extends ChatCompletionResponse>(result: T): T {
  if (!active()) return result;
  const out = { ...result };
  out.choices = result.choices.map(c => ({
    ...c,
    message: {
      ...c.message,
      content: restoreContent(c.message.content) as typeof c.message.content,
      ...(c.message.reasoning_content ? { reasoning_content: restoreContent(c.message.reasoning_content) as string } : {}),
      ...(c.message.tool_calls ? { tool_calls: restoreToolCalls(c.message.tool_calls) } : {}),
    },
  }));
  return out;
}

type Delta = ChatCompletionChunk['choices'][number]['delta'];
// OpenAI streaming deltas are partial calls (id/name/type can occur only in the
// first frame), whereas ChatToolCall describes a complete non-streaming call.
type ToolCallDelta = Partial<Omit<NonNullable<Delta['tool_calls']>[number], 'function'>> & {
  index?: number;
  function?: { name?: string; arguments?: string };
};
type Tail = { index: number; content?: string; reasoning_content?: string; toolCalls: ToolCallDelta[] };

/** A stream has independent text channels. A split placeholder in content must
 *  never consume bytes from reasoning or from another choice's/tool call's
 *  arguments. Keep one restorer per channel, not one for the entire SSE stream. */
class CompletionStreamRestorer {
  private readonly text = new Map<string, StreamRestorer>();
  private readonly arguments = new Map<string, StreamRestorer>();

  restoreChoice(choice: ChatCompletionChunk['choices'][number]): ChatCompletionChunk['choices'][number] {
    const delta = choice.delta;
    const content = typeof delta.content === 'string'
      ? this.pushText(choice.index, 'content', delta.content)
      : undefined;
    const reasoning = typeof delta.reasoning_content === 'string'
      ? this.pushText(choice.index, 'reasoning', delta.reasoning_content)
      : undefined;
    const toolCalls = delta.tool_calls?.map((call, position) => {
      const args = call.function?.arguments;
      if (typeof args !== 'string') return call;
      const restorer = this.restorer(this.arguments, `${choice.index}:${(call as ToolCallDelta).index ?? position}`);
      return { ...call, function: { ...call.function, arguments: restorer.push(args) } };
    });
    if (content === undefined && reasoning === undefined && toolCalls === undefined) return choice;
    return {
      ...choice,
      delta: {
        ...delta,
        ...(content !== undefined ? { content } : {}),
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
      },
    };
  }

  /** Release every held partial placeholder. An incomplete placeholder is not
   *  reversible, but it is still upstream text and must not silently vanish. */
  flush(): Tail[] {
    const tails = new Map<number, Tail>();
    const tailFor = (index: number): Tail => {
      let tail = tails.get(index);
      if (!tail) {
        tail = { index, toolCalls: [] };
        tails.set(index, tail);
      }
      return tail;
    };
    for (const [key, restorer] of this.text) {
      const [index, channel] = key.split(':');
      const value = restorer.flush();
      if (value) tailFor(Number(index))[channel === 'content' ? 'content' : 'reasoning_content'] = value;
    }
    for (const [key, restorer] of this.arguments) {
      const [choiceIndex, toolIndex] = key.split(':').map(Number);
      const value = restorer.flush();
      if (value) {
        tailFor(choiceIndex).toolCalls.push({ index: toolIndex, function: { arguments: value } });
      }
    }
    return [...tails.values()];
  }

  private pushText(index: number, channel: string, value: string): string {
    return this.restorer(this.text, `${index}:${channel}`).push(value);
  }

  private restorer(map: Map<string, StreamRestorer>, key: string): StreamRestorer {
    let restorer = map.get(key);
    if (!restorer) {
      restorer = new StreamRestorer();
      map.set(key, restorer);
    }
    return restorer;
  }
}

/** Wrap a streaming generator so every text channel is restored independently.
 *  A placeholder can span deltas; any held bytes are emitted before the stream
 *  ends rather than discarded. */
export async function* restoreStream(
  gen: AsyncGenerator<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk> {
  if (!active()) {
    yield* gen;
    return;
  }
  const restorer = new CompletionStreamRestorer();
  let last: ChatCompletionChunk | undefined;
  for await (const chunk of gen) {
    last = chunk;
    // An upstream error frame deliberately has no `choices`. Do not turn it
    // into a normal empty-completion chunk: proxy/Anthropic use the ABSENCE
    // of choices to recognize and fail over an in-band provider error.
    if (!chunk.choices) {
      yield chunk;
      continue;
    }
    const out = { ...chunk };
    out.choices = (chunk.choices ?? []).map(choice => restorer.restoreChoice(choice));
    yield out;
  }
  const tails = restorer.flush();
  if (tails.length === 0) return;
  if (!last) return;
  yield {
    id: last.id,
    object: last.object,
    created: last.created,
    model: last.model,
    choices: tails.map(tail => ({
      index: tail.index,
      delta: {
        ...(tail.content !== undefined ? { content: tail.content } : {}),
        ...(tail.reasoning_content !== undefined ? { reasoning_content: tail.reasoning_content } : {}),
        ...(tail.toolCalls.length > 0 ? { tool_calls: tail.toolCalls as Delta['tool_calls'] } : {}),
      },
      finish_reason: null,
    })),
  };
}

/**
 * Wrap a provider so its chat calls are redacted on the way out and restored on
 * the way in. Attached ONCE in router.selectKeyForModel's RouteResult, so every
 * inference surface (proxy / responses / anthropic / inbound-chat) is covered
 * with zero per-route changes. When redaction is off the wrapper is a pure
 * pass-through — the SAME provider object is returned, so identity-sensitive
 * code is unaffected.
 *
 * All other provider methods (embed, rerank, media, validateKey) are delegated
 * untouched via the prototype chain; only chatCompletion/streamChatCompletion
 * are overridden.
 */
export function redactProvider(provider: BaseProvider): BaseProvider {
  if (!active()) return provider;
  // Object.create keeps the concrete provider's own methods/properties reachable
  // through the prototype while we shadow just the two chat methods.
  const wrapped = Object.create(provider) as BaseProvider;
  wrapped.chatCompletion = async (
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> => {
    const result = await provider.chatCompletion(apiKey, maskOutbound(messages), modelId, options, quotaContext);
    return restoreResponse(result);
  };
  wrapped.streamChatCompletion = (
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> => {
    const gen = provider.streamChatCompletion(apiKey, maskOutbound(messages), modelId, options, quotaContext);
    return restoreStream(gen);
  };
  return wrapped;
}

// ── Settings API (dashboard Privacy section) ────────────────────────────────

export interface RedactionSettings {
  enabled: boolean;
  secrets: boolean;
  personal: boolean;
}

/** Current redaction toggles for the dashboard. Reflects the SAME resolution
 *  the router uses (settings table → env → default). */
export function getRedactionSettings(): RedactionSettings {
  return {
    enabled: isRedactEnabled(),
    secrets: redactOptions().secrets,
    personal: redactOptions().personal,
  };
}

/** Persist a partial toggle patch. Writing a value stores it in the settings
 *  table so it takes effect immediately without a restart and wins over env. */
export function updateRedactionSettings(patch: Partial<RedactionSettings>): RedactionSettings {
  if (patch.enabled !== undefined) setSetting(REDACT_ENABLED_SETTING, patch.enabled ? '1' : '0');
  if (patch.secrets !== undefined) setSetting(REDACT_SECRETS_SETTING, patch.secrets ? '1' : '0');
  if (patch.personal !== undefined) setSetting(REDACT_PERSONAL_SETTING, patch.personal ? '1' : '0');
  return getRedactionSettings();
}
