import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { resolveProvider } from '../../providers/index.js';
import {
  buildResponsesBody,
  isAgentRouterEndpoint,
  normalizeResponsesToChat,
  responsesInputItems,
  responsesToolChoice,
  usesResponsesUpstream,
} from '../../lib/responses-upstream.js';

describe('responses-upstream gating', () => {
  it('detects AgentRouter hosts only', () => {
    expect(isAgentRouterEndpoint('https://agentrouter.org/v1')).toBe(true);
    expect(isAgentRouterEndpoint('https://api.agentrouter.org/v1')).toBe(true);
    expect(isAgentRouterEndpoint('https://agentrouter.org.evil.test/v1')).toBe(false);
    expect(isAgentRouterEndpoint('https://api.groq.com/openai/v1')).toBe(false);
    expect(isAgentRouterEndpoint('not a url')).toBe(false);
  });

  it('routes only custom-platform AgentRouter responses-only models', () => {
    expect(usesResponsesUpstream('https://agentrouter.org/v1', 'custom', 'gpt-6-astra')).toBe(true);
    // other AgentRouter models keep the chat path
    expect(usesResponsesUpstream('https://agentrouter.org/v1', 'custom', 'gpt-5.6-sol')).toBe(true);
    expect(usesResponsesUpstream('https://agentrouter.org/v1', 'custom', 'gpt-6.1-sol')).toBe(true);
    expect(usesResponsesUpstream('https://agentrouter.org/v1', 'custom', 'gemini-3-pro')).toBe(false);
    // same model id on another host/platform keeps the chat path
    expect(usesResponsesUpstream('https://api.groq.com/openai/v1', 'custom', 'gpt-6-astra')).toBe(false);
    expect(usesResponsesUpstream('https://agentrouter.org/v1', 'openrouter', 'gpt-6-astra')).toBe(false);
  });
});

describe('responses request building', () => {
  it('hoists system messages into instructions', () => {
    const body = buildResponsesBody(
      [
        { role: 'system', content: 'be terse' },
        { role: 'system', content: 'always json' },
        { role: 'user', content: 'hi' },
      ],
      'gpt-6-astra',
    );
    expect(body.instructions).toBe('be terse\n\nalways json');
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps tool history to function_call / function_call_output items', () => {
    const items = responsesInputItems([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('maps chat tool_choice to the Responses shape', () => {
    expect(responsesToolChoice({ type: 'function', function: { name: 'get_weather' } }))
      .toEqual({ type: 'function', name: 'get_weather' });
    expect(responsesToolChoice('auto')).toBe('auto');
    expect(responsesToolChoice(undefined)).toBeUndefined();
  });

  it('builds tools and json_schema text format', () => {
    const body = buildResponsesBody([{ role: 'user', content: 'x' }], 'm', {
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: { type: 'object' } } },
      max_tokens: 64,
      temperature: 0.5,
    });
    expect(body.tools).toEqual([{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: undefined }]);
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } });
    expect(body.max_output_tokens).toBe(64);
    expect(body.temperature).toBe(0.5);
  });
});

describe('normalizeResponsesToChat', () => {
  const makeId = () => 'chatcmpl-test';

  it('extracts text, tool calls, usage and finish_reason', () => {
    const out = normalizeResponsesToChat({
      id: 'resp_1', status: 'completed', model: 'gpt-6-astra', created_at: 1000,
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
    }, 'gpt-6-astra', 'custom', makeId);
    expect(out.choices[0].message.content).toBe('OK');
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls?.[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"北京"}' });
    expect(out.usage).toEqual({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(out._routed_via).toEqual({ platform: 'custom', model: 'gpt-6-astra' });
  });

  it('maps incomplete/max_output_tokens to finish_reason length', () => {
    const out = normalizeResponsesToChat({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    }, 'gpt-6-astra', 'custom', makeId);
    expect(out.choices[0].finish_reason).toBe('length');
  });
});

describe('OpenAICompatProvider upstream Responses wiring', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function provider(): OpenAICompatProvider {
    return new OpenAICompatProvider({
      platform: 'custom',
      name: 'Custom (OpenAI-compatible)',
      baseUrl: 'https://agentrouter.org/v1',
      extraHeaders: { 'User-Agent': 'claude-cli/2.1.301 (external, sdk-cli)' },
    });
  }

  function sseResponse(frames: string[]): any {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return { ok: true, body: stream, headers: new Headers() };
  }

  const sseFrame = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  it('posts to /responses with the Responses body and normalizes the reply', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'resp_9', status: 'completed', model: 'gpt-6-astra', created_at: 42,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }),
      } as any;
    });

    const out = await provider().chatCompletion(
      'k', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Say OK' }], 'gpt-6-astra',
    );
    expect(capturedUrl).toBe('https://agentrouter.org/v1/responses');
    expect(capturedHeaders['User-Agent']).toBe('claude-cli/2.1.301 (external, sdk-cli)');
    expect(capturedBody.instructions).toBe('sys');
    expect(capturedBody.input).toEqual([{ role: 'user', content: 'Say OK' }]);
    expect(capturedBody.stream).toBeUndefined();
    expect(out.choices[0].message.content).toBe('OK');
    expect(out.choices[0].finish_reason).toBe('stop');
  });

  it('translates Responses SSE into chat chunks (text, tool call, usage, finish)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([
      sseFrame('response.created', { response: { id: 'r' } }),
      sseFrame('response.output_text.delta', { delta: 'Hel' }),
      sseFrame('response.output_text.delta', { delta: 'lo' }),
      sseFrame('response.output_item.added', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'get_weather' } }),
      sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"city":' }),
      sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '"北京"}' }),
      sseFrame('response.completed', {
        response: {
          id: 'r', status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
            { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"北京"}' },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        },
      }),
    ]));

    const chunks = await collect(provider().streamChatCompletion('k', [{ role: 'user', content: 'x' }], 'gpt-6-astra'));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks[1].choices[0].delta.content).toBe('Hel');
    expect(chunks[2].choices[0].delta.content).toBe('lo');
    const toolOpen = chunks[3].choices[0].delta.tool_calls?.[0] as any;
    expect(toolOpen).toMatchObject({ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } });
    const argFrags = chunks.filter(c => (c.choices[0]?.delta.tool_calls as any[] | undefined)?.[0]?.function?.arguments)
      .map(c => (c.choices[0].delta.tool_calls as any[])[0].function.arguments as string);
    expect(argFrags.join('')).toBe('{"city":"北京"}');
    const finish = chunks.find(c => c.choices[0].finish_reason !== null);
    expect(finish?.choices[0].finish_reason).toBe('tool_calls');
    const usageChunk = chunks.find(c => c.usage);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it('surfaces response.failed as a throw and truncation on abrupt EOF', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([
      sseFrame('response.failed', { response: { error: { message: 'quota exhausted' } } }),
    ]));
    await expect(collect(provider().streamChatCompletion('k', [], 'gpt-6-astra')))
      .rejects.toThrow(/quota exhausted/);

    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([
      sseFrame('response.output_text.delta', { delta: 'partial' }),
    ]));
    await expect(collect(provider().streamChatCompletion('k', [], 'gpt-6-astra')))
      .rejects.toThrow(/ended unexpectedly/);
  });

  it('does not touch the chat path for non-responses-only models on the same host', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toBe('https://agentrouter.org/v1/chat/completions');
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'c', object: 'chat.completion', created: 1, model: 'gemini-3-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });
    const out = await provider().chatCompletion('k', [{ role: 'user', content: 'x' }], 'gemini-3-pro');
    expect(out.choices[0].message.content).toBe('hi');
  });
});

describe('resolveProvider AgentRouter UA gating', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CHE_CUSTOM_AGENTROUTER_UA; });

  it('sends a claude-cli UA to AgentRouter and an OpenClaw UA to Moonshot', async () => {
    const ar = resolveProvider('custom', 'https://agentrouter.org/v1') as OpenAICompatProvider;
    const mp = resolveProvider('custom', 'https://api.moonshot.ai/v1') as OpenAICompatProvider;
    const other = resolveProvider('custom', 'https://api.groq.com/openai/v1') as OpenAICompatProvider;
    // The UA travels through the private extraHeaders field; verify via a
    // captured request instead of poking internals.
    let arUa = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      arUa = ((init as any).headers as Record<string, string>)['User-Agent'];
      return { ok: true, json: () => Promise.resolve({ data: [] }) } as any;
    });
    await ar.validateKey('k');
    expect(arUa).toContain('claude-cli');
    let mpUa = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      mpUa = ((init as any).headers as Record<string, string>)['User-Agent'];
      return { ok: true, json: () => Promise.resolve({ data: [] }) } as any;
    });
    await mp.validateKey('k');
    expect(mpUa).toBe('OpenClaw');
    await other.validateKey('k'); // no UA assertion — plain headers
  });

  it('honors CHE_CUSTOM_AGENTROUTER_UA override', async () => {
    process.env.CHE_CUSTOM_AGENTROUTER_UA = 'CustomUA/1';
    let ua = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      ua = ((init as any).headers as Record<string, string>)['User-Agent'];
      return { ok: true, json: () => Promise.resolve({ data: [] }) } as any;
    });
    await (resolveProvider('custom', 'https://agentrouter.org/v1') as OpenAICompatProvider).validateKey('k');
    expect(ua).toBe('CustomUA/1');
  });
});
