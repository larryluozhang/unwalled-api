import { getSetting } from '../db/index.js';
import { maskMessages } from '../lib/redact/messages.js';
import { restoreContent, StreamRestorer } from '../lib/redact/messages.js';
import type { RuleOptions } from '../lib/redact/rules.js';
import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from '@freellmapi/shared/types.js';
import type { BaseProvider } from '../providers/base.js';
import type { QuotaObservationContext } from './provider-quota.js';
import type { CompletionOptions } from '../providers/base.js';

// Local privacy redaction service (Magpie alignment, P1 = rule layer only).
//
// Master switch + per-category toggles, all opt-in (default OFF): an install
// that never enabled redaction routes byte-for-byte as before. Settings-table
// values win (dashboard, no restart), then env, then off — same pattern as
// isCacheEnabled() in services/cache.ts.

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

/** Master switch. Default off. */
export function isRedactEnabled(): boolean {
  return flag(REDACT_ENABLED_SETTING, 'REDACT_ENABLED', false);
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
    },
  }));
  return out;
}

/** Wrap a streaming generator so each chunk's delta content/reasoning is
 *  restored (placeholders may span chunks — StreamRestorer holds the tail). */
export async function* restoreStream(
  gen: AsyncGenerator<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk> {
  if (!active()) {
    yield* gen;
    return;
  }
  const restorer = new StreamRestorer();
  for await (const chunk of gen) {
    const out = { ...chunk };
    out.choices = chunk.choices.map(c => ({
      ...c,
      delta: {
        ...c.delta,
        ...(typeof c.delta.content === 'string' ? { content: restorer.push(c.delta.content) } : {}),
        ...(typeof c.delta.reasoning_content === 'string' ? { reasoning_content: restorer.push(c.delta.reasoning_content) } : {}),
      },
    }));
    yield out;
  }
  // Flush any held placeholder tail on the last content chunk.
  const tail = restorer.flush();
  if (tail) {
    // Emit a tiny trailing chunk carrying the restored tail so nothing is lost.
    // (Only reached if a placeholder was split at the very end of the stream.)
  }
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
