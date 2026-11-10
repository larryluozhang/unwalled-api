import { beforeEach, describe, expect, it } from 'vitest';
import { findSpans } from '../../lib/redact/rules.js';
import { maskText, restoreText } from '../../lib/redact/mask.js';
import { maskMessage, StreamRestorer, restoreContent } from '../../lib/redact/messages.js';
import { clearRedactionStore, placeholderFor, register, restoreValue } from '../../lib/redact/store.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const opts = { secrets: true, personal: true };
beforeEach(() => clearRedactionStore());

describe('PII detection', () => {
  it('detects emails, phones, id cards', () => {
    const text = '联系我 alice@example.com 或 13800138000，身份证 110101199003074321';
    const kinds = findSpans(text, opts).map(s => s.kind);
    expect(kinds).toContain('EMAIL');
    expect(kinds).toContain('PHONE');
    expect(kinds).toContain('ID_CARD');
  });

  it('detects secrets by prefix and by field name', () => {
    expect(findSpans('key sk-abcdefghijklmnop1234', opts).some(s => s.kind === 'API_KEY')).toBe(true);
    expect(findSpans('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01234', opts).some(s => s.kind === 'API_KEY')).toBe(true);
    const spans = findSpans('api_key: "supersecretvalue123"', opts);
    expect(spans.some(s => s.kind === 'SECRET')).toBe(true);
  });

  it('does NOT mask an order id that merely looks like a phone', () => {
    expect(findSpans('订单号 13912345678 已发货', opts).some(s => s.kind === 'PHONE')).toBe(false);
    expect(findSpans('order_id=18612345678', opts).some(s => s.kind === 'PHONE')).toBe(false);
    // but a real phone context still masks
    expect(findSpans('我的手机号是 13800138000', opts).some(s => s.kind === 'PHONE')).toBe(true);
  });

  it('never masks a UUID or 32-hex id (model reads it back)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(findSpans(`session ${uuid}`, opts).some(s => s.kind === 'PHONE' || s.kind === 'BANK_CARD')).toBe(false);
    const hex = '0123456789abcdef0123456789abcdef';
    expect(findSpans(`commit ${hex}`, opts).some(s => s.kind === 'BANK_CARD')).toBe(false);
  });

  it('validates bank cards with Luhn (rejects non-card digit runs)', () => {
    expect(findSpans('card 4111111111111111', opts).some(s => s.kind === 'BANK_CARD')).toBe(true); // valid Luhn
    expect(findSpans('num 4111111111111112', opts).some(s => s.kind === 'BANK_CARD')).toBe(false); // bad Luhn
  });
});

describe('reversible masking', () => {
  it('masks then restores to the original text', () => {
    const original = 'email alice@example.com phone 13800138000';
    const masked = maskText(original, opts);
    expect(masked).not.toContain('alice@example.com');
    expect(masked).not.toContain('13800138000');
    expect(masked).toContain('{{EMAIL_');
    expect(masked).toContain('{{PHONE_');
    expect(restoreText(masked)).toBe(original);
  });

  it('same value yields the same placeholder (cache-stable)', () => {
    const p1 = placeholderFor('alice@example.com', 'EMAIL');
    const p2 = placeholderFor('alice@example.com', 'EMAIL');
    expect(p1).toBe(p2);
    register('alice@example.com', 'EMAIL');
    expect(restoreValue(p1)).toBe('alice@example.com');
  });

  it('re-masks a known value that appears verbatim later (no rule matched)', () => {
    maskText('alice@example.com', opts); // registers the value
    const masked = maskText('tell alice@example.com again', opts);
    expect(masked).not.toContain('alice@example.com');
    expect(restoreText(masked)).toBe('tell alice@example.com again');
  });
});

describe('message masking preserves structure', () => {
  it('masks text but keeps tool_call id, name, and image refs', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'call alice@example.com' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] as any,
      tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'send_email', arguments: JSON.stringify({ to: 'alice@example.com', call_id: 'keepme' }) } }],
    };
    const masked = maskMessage(msg, opts);
    // text block masked
    expect(JSON.stringify(masked.content)).not.toContain('alice@example.com');
    // image url kept
    expect(JSON.stringify(masked.content)).toContain('https://x/y.png');
    // tool id/name kept
    expect(masked.tool_calls![0].id).toBe('call_123');
    expect(masked.tool_calls![0].function.name).toBe('send_email');
    // arguments: email masked, but call_id key kept
    const args = JSON.parse(masked.tool_calls![0].function.arguments);
    expect(args.to).not.toBe('alice@example.com');
    expect(args.call_id).toBe('keepme');
    // round-trips back
    const restored = restoreContent(masked.content);
    expect(JSON.stringify(restored)).toContain('alice@example.com');
  });
});

describe('streaming restore across split placeholders', () => {
  it('restores a placeholder split across two deltas', () => {
    const masked = maskText('mail alice@example.com', opts);
    const placeholder = masked.slice(masked.indexOf('{{'));
    const mid = Math.floor(placeholder.length / 2);
    const r = new StreamRestorer();
    const a = r.push(placeholder.slice(0, mid));
    const b = r.push(placeholder.slice(mid));
    const tail = r.flush();
    expect(a + b + tail).toBe('alice@example.com');
  });

  it('passes through plain text with no placeholder', () => {
    const r = new StreamRestorer();
    expect(r.push('hello ') + r.push('world') + r.flush()).toBe('hello world');
  });
});
