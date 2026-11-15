import { beforeEach, describe, expect, it } from 'vitest';
import { restoreResponse, restoreStream, maskOutbound, updateRedactionSettings } from '../../services/redaction.js';
import { clearRedactionStore, register } from '../../lib/redact/store.js';
import { restoreText } from '../../lib/redact/mask.js';
import { initDb } from '../../db/index.js';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  clearRedactionStore();
});

function chunk(delta: Record<string, unknown>, index = 0): ChatCompletionChunk {
  return {
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{ index, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason: null }],
  };
}

async function collect(source: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of source) out.push(c);
  return out;
}

describe('outbound placeholder semantics', () => {
  it('explains the placeholder vocabulary to the upstream only when a value was masked', () => {
    const original = 'Please repeat this email exactly: {{EMAIL_rgq3h3qv}}';
    const masked = maskOutbound([{ role: 'user', content: original }]);
    expect(masked).toHaveLength(2);
    expect(masked[0].role).toBe('system');
    expect(masked[0].content).toContain('real values');
    expect(masked[1].content).toContain('{{EMAIL_');
    const roundTrip = masked.map(m => ({ ...m, content: restoreText(m.content as string) }));
    expect(roundTrip[1].content).toBe(original);
    expect(maskOutbound([{ role: 'user', content: 'ordinary text' }])).toHaveLength(1);
  });

  it('explains the email kind without annotating the value itself', () => {
    const masked = maskOutbound([{ role: 'user', content: 'Repeat alice@example.com' }]);
    expect(masked[0].content).toMatch(/EMAIL is an email address/);
    expect(masked[1].content).toMatch(/^Repeat \{\{EMAIL_[0-9a-z]{8}\}\}$/);
    expect(masked[1].content).not.toContain('alice@example.com');
  });

  it('merges the explanation into an existing first system message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Original instruction' },
      { role: 'user', content: 'Repeat alice@example.com' },
    ];
    const masked = maskOutbound(messages);
    expect(masked).toHaveLength(2);
    expect(masked[0].content).toMatch(/^Original instruction\n\n/);
    expect(masked[0].content).toContain('real values');
    expect(messages[0].content).toBe('Original instruction');
  });

  it('leaves the original array reference untouched when redaction is disabled', () => {
    updateRedactionSettings({ enabled: false });
    const messages: ChatMessage[] = [{ role: 'user', content: 'ordinary text' }];
    expect(maskOutbound(messages)).toBe(messages);
  });
});

describe('response restoration', () => {
  it('restores placeholders in non-streaming tool arguments, without parsing or reformatting JSON', () => {
    const p = register(['dev', '@', 'example.com'].join(''), 'EMAIL');
    const result = {
      id: 'r1', object: 'chat.completion', created: 1, model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mail', arguments: `{"to":"${p}"}` } }],
        },
        finish_reason: 'tool_calls',
      }],
    } as ChatCompletionResponse;
    const restored = restoreResponse(result);
    expect(restored.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"to":"dev@example.com"}');
  });

  it('keeps content and reasoning buffers independent when a placeholder is split', async () => {
    const email = ['dev', '@', 'example.com'].join('');
    const p = register(email, 'EMAIL');
    const reasoning = register(['thinking', '@', 'example.com'].join(''), 'EMAIL');
    const mid = Math.floor(p.length / 2);
    const rMid = Math.floor(reasoning.length / 2);
    const out = await collect(restoreStream((async function* () {
      yield chunk({ content: p.slice(0, mid), reasoning_content: reasoning.slice(0, rMid) });
      yield chunk({ content: p.slice(mid), reasoning_content: reasoning.slice(rMid) });
    })()));
    expect(out.map(c => c.choices[0].delta.content ?? '').join('')).toBe(email);
    expect(out.map(c => c.choices[0].delta.reasoning_content ?? '').join('')).toBe('thinking@example.com');
  });

  it('keeps each choice restoration buffer independent', async () => {
    const p = register(['dev', '@', 'example.com'].join(''), 'EMAIL');
    const mid = Math.floor(p.length / 2);
    const out = await collect(restoreStream((async function* () {
      yield {
        ...chunk({}), choices: [
          { index: 0, delta: { content: p.slice(0, mid) }, finish_reason: null },
          { index: 1, delta: { content: p.slice(0, mid) }, finish_reason: null },
        ],
      } as ChatCompletionChunk;
      yield {
        ...chunk({}), choices: [
          { index: 0, delta: { content: p.slice(mid) }, finish_reason: null },
          { index: 1, delta: { content: p.slice(mid) }, finish_reason: null },
        ],
      } as ChatCompletionChunk;
    })()));
    for (const index of [0, 1]) {
      const content = out.flatMap(c => c.choices.filter(x => x.index === index)).map(c => c.delta.content ?? '').join('');
      expect(content).toBe('dev@example.com');
    }
  });

  it('restores placeholders across streaming tool argument deltas', async () => {
    const p = register(['dev', '@', 'example.com'].join(''), 'EMAIL');
    const mid = Math.floor(p.length / 2);
    const out = await collect(restoreStream((async function* () {
      yield chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'mail', arguments: `{"to":"${p.slice(0, mid)}` } }] });
      yield chunk({ tool_calls: [{ index: 0, function: { arguments: `${p.slice(mid)}"}` } }] });
    })()));
    const args = out.flatMap(c => c.choices[0].delta.tool_calls ?? []).map(c => c.function?.arguments ?? '').join('');
    expect(args).toBe('{"to":"dev@example.com"}');
    expect(out.flatMap(c => c.choices[0].delta.tool_calls ?? [])[0].id).toBe('call-1');
  });

  it('passes upstream error frames with no choices array through unchanged', async () => {
    const frame = { error: { message: 'bad request', code: 'tool_use_failed' } } as unknown as ChatCompletionChunk;
    const out = await collect(restoreStream((async function* () { yield frame; })()));
    expect(out).toEqual([frame]);
    expect(out[0].choices).toBeUndefined();
  });

  it('flushes a held trailing partial placeholder instead of dropping it', async () => {
    const out = await collect(restoreStream((async function* () {
      yield chunk({ content: 'literal {{EMA' });
    })()));
    expect(out.map(c => c.choices[0].delta.content ?? '').join('')).toBe('literal {{EMA');
  });

  it('flushes trailing partial tool arguments instead of dropping them', async () => {
    const out = await collect(restoreStream((async function* () {
      yield chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'f', arguments: '{"x":"{{EMA' } }] });
    })()));
    const args = out.flatMap(c => c.choices[0].delta.tool_calls ?? []).map(c => c.function?.arguments ?? '').join('');
    expect(args).toBe('{"x":"{{EMA');
  });
});
