import type { ChatMessage } from '@freellmapi/shared/types.js';

// Explain the placeholder vocabulary in a separate upstream-only instruction.
// Never annotate a placeholder in-place: a model asked to quote it verbatim
// could copy the annotation too, adding text to a restored credential or tool
// argument. The original token remains untouched and cache-stable.

const SYSTEM_INSTRUCTION = `Some private values in this conversation are replaced by opaque placeholders of the form {{KIND_hash8}}, for example {{EMAIL_xxxxxxxx}} or {{API_KEY_xxxxxxxx}}. KIND names the real value's type (EMAIL is an email address, PHONE is a phone number, API_KEY/TOKEN/SECRET are credentials). These placeholders stand for real values, not unresolved templates. Treat each placeholder as the value it represents in its original context. When asked to repeat, quote, compare, or use such a value, copy its placeholder EXACTLY, including both pairs of braces, with no added explanation; do not say that you cannot see the underlying value. The local gateway will restore the real value in your response. Never invent, alter, or decode a placeholder.`;

const PLACEHOLDER_RE = /\{\{([A-Z_]+)_[0-9a-z]{8}\}\}/g;

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(value);
  }
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(hasPlaceholder);
  return false;
}

/** Add the upstream-only explanation only when the request really carries a
 *  masked value. The original messages are not mutated, multimodal blocks keep
 *  their structure, and no-placeholder requests retain their exact shape. */
export function explainMaskedMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!hasPlaceholder(messages)) return messages;
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
    return [{ ...messages[0], content: `${messages[0].content}\n\n${SYSTEM_INSTRUCTION}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: SYSTEM_INSTRUCTION }, ...messages];
}
