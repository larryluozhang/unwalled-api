import type { ChatMessage } from '@freellmapi/shared/types.js';
import { maskText, restoreText } from './mask.js';
import type { RuleOptions } from './rules.js';

const KEPT_KEYS = new Set([
  'signature', 'encrypted_content', 'data', 'thoughtSignature', 'thought_signature',
  'model', 'id', 'tool_use_id', 'tool_call_id', 'call_id', 'item_id', 'type', 'role',
  'name', 'namespace', 'server_label', 'server_name', 'previous_response_id',
  'prompt_cache_key', 'media_type', 'mime_type', 'mimeType', 'url', 'image_url',
  'file_id', 'reasoning_effort', 'effort', 'stop_reason', 'finish_reason',
  'status', 'object', 'event', 'partial',
]);

function isKeptKey(key: string): boolean {
  return KEPT_KEYS.has(key) || /_id$/.test(key);
}

function maskContent(content: unknown, opts: RuleOptions): unknown {
  if (typeof content === 'string') return maskText(content, opts);
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return maskText(block, opts);
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string' && (b.type === 'text' || b.type === undefined || b.type === 'input_text' || b.type === 'output_text')) {
          return { ...b, text: maskText(b.text, opts) };
        }
        return b;
      }
      return block;
    });
  }
  return content;
}

function maskJsonValue(value: unknown, opts: RuleOptions): unknown {
  if (typeof value === 'string') return maskText(value, opts);
  if (Array.isArray(value)) return value.map(v => maskJsonValue(v, opts));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isKeptKey(k) || (typeof v === 'string' && v.startsWith('data:'))) {
        out[k] = v;
      } else {
        out[k] = maskJsonValue(v, opts);
      }
    }
    return out;
  }
  return value;
}

export function maskMessage(message: ChatMessage, opts: RuleOptions): ChatMessage {
  const out: ChatMessage = { ...message };
  out.content = maskContent(message.content, opts) as ChatMessage['content'];
  if (typeof message.reasoning_content === 'string') {
    out.reasoning_content = maskText(message.reasoning_content, opts);
  }
  if (message.tool_calls) {
    out.tool_calls = message.tool_calls.map(tc => {
      const args = tc.function?.arguments;
      if (typeof args !== 'string') return tc;
      let maskedArgs: string;
      try {
        maskedArgs = JSON.stringify(maskJsonValue(JSON.parse(args), opts));
      } catch {
        maskedArgs = maskText(args, opts);
      }
      return { ...tc, function: { ...tc.function, arguments: maskedArgs } };
    });
  }
  return out;
}

export function maskMessages(messages: ChatMessage[], opts: RuleOptions): ChatMessage[] {
  return messages.map(m => maskMessage(m, opts));
}

export function restoreContent(content: unknown): unknown {
  if (typeof content === 'string') return restoreText(content);
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return restoreText(block);
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') return { ...b, text: restoreText(b.text) };
        return b;
      }
      return block;
    });
  }
  return content;
}

export class StreamRestorer {
  private pending = '';

  push(delta: string): string {
    if (!delta && !this.pending) return '';
    let buf = this.pending + delta;
    this.pending = '';
    const hold = this.holdTail(buf);
    if (hold > 0) {
      this.pending = buf.slice(buf.length - hold);
      buf = buf.slice(0, buf.length - hold);
    }
    return restoreText(buf);
  }

  flush(): string {
    const out = restoreText(this.pending);
    this.pending = '';
    return out;
  }

  private holdTail(s: string): number {
    const lastOpen = s.lastIndexOf('{{');
    if (lastOpen === -1) return 0;
    const lastClose = s.lastIndexOf('}}');
    if (lastClose > lastOpen) return 0;
    const tail = s.slice(lastOpen);
    if (/^\{\{[A-Z_]*[0-9a-z]{0,8}$/.test(tail) || /^\{\{[A-Z_]*$/.test(tail) || tail === '{{' || tail === '{') {
      return tail.length;
    }
    return 0;
  }
}
