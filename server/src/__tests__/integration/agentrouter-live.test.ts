import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { applyProxyUrl } from '../../lib/proxy.js';

/**
 * Live smoke against AgentRouter's upstream Responses API (gpt-6-astra).
 * Runs ONLY when AR_LIVE_TOKEN is set in the environment (a real
 * agentrouter.org key); skipped in CI/normal runs. The token is injected
 * via env and never read from disk or logged.
 */
const token = process.env.AR_LIVE_TOKEN;

function provider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    platform: 'custom',
    name: 'AgentRouter (live)',
    baseUrl: 'https://agentrouter.org/v1',
    extraHeaders: { 'User-Agent': 'claude-cli/2.1.301 (external, sdk-cli)' },
  });
}

describe.skipIf(!token)('AgentRouter live /v1/responses', () => {
  // applyProxyUrl normally runs at app startup; in a bare test process it
  // must be applied explicitly for PROXY_URL to take effect.
  beforeAll(() => { applyProxyUrl(''); });

  it('answers a non-stream chatCompletion through the Responses translation', async () => {
    const out = await provider().chatCompletion('' + token, [{ role: 'user', content: 'Reply with exactly OK.' }], 'gpt-6-astra', { max_tokens: 128 });
    expect(out.choices[0].message.content).toContain('OK');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage.prompt_tokens).toBeGreaterThan(0);
  }, 120_000);

  it('streams text deltas through the Responses translation', async () => {
    const chunks = [];
    for await (const c of provider().streamChatCompletion('' + token, [{ role: 'user', content: 'Reply with exactly OK.' }], 'gpt-6-astra', { max_tokens: 128 })) {
      chunks.push(c);
    }
    const text = chunks.map(c => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toContain('OK');
    const finish = chunks.find(c => c.choices[0]?.finish_reason !== null);
    expect(finish?.choices[0].finish_reason).toBe('stop');
    expect(chunks.some(c => c.usage)).toBe(true);
  }, 120_000);

  it('returns a function tool call through the Responses translation', async () => {
    const out = await provider().chatCompletion('' + token,
      [{ role: 'user', content: 'Look up the weather in Beijing using the tool. Do not answer without calling it.' }],
      'gpt-6-astra',
      {
        max_tokens: 256,
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      });
    const tc = out.choices[0].message.tool_calls?.[0];
    expect(tc?.function.name).toBe('get_weather');
    expect(JSON.parse(tc!.function.arguments)).toEqual({ city: 'Beijing' });
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  }, 120_000);
});
