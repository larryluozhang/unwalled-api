import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider, resolveProvider } from '../../providers/index.js';
import { usesResponsesUpstream } from '../../lib/responses-upstream.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// che.24: AgentRouter as a BUILT-IN platform — key-only onboarding through the
// standard POST /api/keys (fixed base URL), model discovery/registration via
// POST /api/keys/agentrouter/discover-models (the upstream /v1/models needs a
// claude-cli User-Agent), and the three responses-only models must keep
// routing through the upstream Responses API. Rows are registered with
// source='model_discovery' (operator-registered, like custom endpoints) so
// catalog-sync never GCs them.

const ADD_KEY = '/api/keys';
const AR_DISCOVER = '/api/keys/agentrouter/discover-models';
const AR_MODELS = '/api/keys/agentrouter/models';
const AR_BASE = 'https://agentrouter.org/v1';
const realFetch = globalThis.fetch;

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, auth = true) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as any };
}

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);
const get = (app: Express, path: string) => request(app, 'GET', path);

function stubAgentRouter(payload: unknown, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  globalThis.fetch = mock as any;
  return mock;
}

describe('AgentRouter built-in platform (che.24)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers the provider with a fixed base URL and no keyless sentinel', () => {
    const p = getProvider('agentrouter');
    expect(p).toBeDefined();
    expect(p!.name).toBe('AgentRouter');
    expect((p as any).baseUrl).toBe(AR_BASE);
    expect(p!.keyless).toBe(false);
    expect(resolveProvider('agentrouter')).toBe(p);
  });

  it('accepts a key through the standard add-key route and discovers models automatically', async () => {
    const mock = stubAgentRouter({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }] });
    const { status, body } = await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    expect(status).toBe(201);
    expect(body.platform).toBe('agentrouter');
    expect(body.modelsAvailable).toBe(2);
    expect(body.agentRouterNotice).toContain('2 responses-only model(s) registered');
    expect(mock).toHaveBeenCalledTimes(1);
    const row = getDb().prepare("SELECT platform, base_url FROM api_keys WHERE platform = 'agentrouter'").get() as { platform: string; base_url: string | null };
    expect(row.platform).toBe('agentrouter');
    expect(row.base_url).toBeNull(); // fixed base URL — nothing user-supplied
    const models = getDb().prepare("SELECT model_id FROM models WHERE platform = 'agentrouter'").all() as any[];
    expect(models.map(m => m.model_id).sort()).toEqual(['gpt-5.6-sol', 'gpt-6-astra']);
    const fallback = getDb().prepare("SELECT f.enabled FROM fallback_config f JOIN models m ON m.id = f.model_db_id WHERE m.platform = 'agentrouter'").all() as any[];
    expect(fallback).toHaveLength(2);
    expect(fallback.every(m => m.enabled === 0)).toBe(true);
  });

  it('keeps the key usable when automatic discovery fails, without a misleading success notice', async () => {
    stubAgentRouter({ error: { message: 'upstream unavailable' } }, 502);
    const { status, body } = await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    expect(status).toBe(201);
    expect(body.modelsAvailable).toBe(0);
    expect(body.agentRouterNotice).toContain('key saved, but model discovery failed');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'agentrouter'").get()).toEqual({ n: 1 });
  });

  it('makes the three supported models requestable through the built-in provider via /responses', async () => {
    let lastUrl = '';
    globalThis.fetch = vi.fn(async (url, _init) => {
      lastUrl = String(url);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'r', status: 'completed', model: 'gpt-6-astra', created_at: 1,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    }) as any;

    const p = resolveProvider('agentrouter') as OpenAICompatProvider;
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6.1-sol']) {
      const out = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], model);
      expect(lastUrl).toBe(`${AR_BASE}/responses`);
      expect(out._routed_via).toEqual({ platform: 'agentrouter', model });
    }
  });

  it('exposes supported models to the global no-profile chain as disabled rows', async () => {
    stubAgentRouter({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] });
    await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    const rows = getDb().prepare(`
      SELECT m.model_id, f.enabled FROM models m
      JOIN fallback_config f ON f.model_db_id = m.id
      WHERE m.platform = 'agentrouter' ORDER BY m.model_id
    `).all() as any[];
    expect(rows).toEqual([{ model_id: 'gpt-5.6-sol', enabled: 0 }, { model_id: 'gpt-6-astra', enabled: 0 }, { model_id: 'gpt-6.1-sol', enabled: 0 }]);
  });

  it('appears in the /api/keys/providers checklist as an unconfigured provider', async () => {
    const { status, body } = await get(app, '/api/keys/providers');
    expect(status).toBe(200);
    const ar = (body.providers as any[]).find(p => p.platform === 'agentrouter');
    expect(ar).toBeDefined();
    expect(ar.name).toBe('AgentRouter');
    expect(ar.configured).toBe(false);
  });

  it('discovers /v1/models with the claude-cli UA and registers rows bound to the platform key', async () => {
    stubAgentRouter({ data: [] });
    await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    const mock = stubAgentRouter({
      object: 'list',
      data: [
        { id: 'gpt-5.6-sol', owned_by: 'agentrouter' },
        { id: 'gpt-6-astra', owned_by: 'agentrouter' },
        { id: 'gemini-3-pro', owned_by: 'google' },
      ],
    });

    const { status, body } = await post(app, AR_DISCOVER, {});
    expect(status).toBe(200);
    expect(body.discovered).toBe(2);
    expect(body.added).toBe(2);
    expect(body.alreadyRegistered).toBe(0);
    // The flagship is first in the registered list (responses-only ids lead).
    expect(body.models[0].id).toBe('gpt-6-astra');
    expect(body.models.map((m: any) => m.id)).toContain('gpt-5.6-sol');

    // The UA is the discovery gate — AgentRouter 401s non-claude-cli UAs.
    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(String(mock.mock.calls[0][0])).toBe(`${AR_BASE}/models`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-ar-test-key');
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('claude-cli');

    const db = getDb();
    const rows = db.prepare("SELECT model_id, display_name, enabled, source, key_id, platform FROM models WHERE platform = 'agentrouter' ORDER BY model_id").all() as any[];
    expect(rows.map(r => r.model_id).sort()).toEqual(['gpt-5.6-sol', 'gpt-6-astra']);
    for (const r of rows) {
      expect(r.source).toBe('model_discovery');
      expect(r.enabled).toBe(1);
      expect(r.key_id).toBe(body.keyId);
    }
    // Registered rows are visible to the chain editor but never auto-enabled.
    const inChain = db.prepare(`
      SELECT f.enabled FROM fallback_config f JOIN models m ON m.id = f.model_db_id
       WHERE m.platform = 'agentrouter'
    `).all() as { enabled: number }[];
    expect(inChain).toHaveLength(2);
    expect(inChain.every(row => row.enabled === 0)).toBe(true);
  });

  it('is idempotent and preserves an operator-disabled model on re-sync', async () => {
    stubAgentRouter({ data: [] });
    await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    stubAgentRouter({ data: [{ id: 'gpt-6-astra' }] });
    const first = await post(app, AR_DISCOVER, {});
    expect(first.body.added).toBe(1);

    // Operator disables the row; a re-run must not undo that choice.
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'agentrouter' AND model_id = 'gpt-6-astra'").run();
    stubAgentRouter({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] });
    const second = await post(app, AR_DISCOVER, {});
    expect(second.body.added).toBe(1);
    expect(second.body.alreadyRegistered).toBe(1);
    const rows = db.prepare("SELECT model_id, enabled FROM models WHERE platform = 'agentrouter'").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.model_id === 'gpt-6-astra')!.enabled).toBe(0);
  });

  it('returns the locally registered models from GET without network', async () => {
    stubAgentRouter({ data: [{ id: 'gpt-6-astra' }] });
    await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-test-key' });
    stubAgentRouter({ data: [{ id: 'gpt-6-astra' }] });
    await post(app, AR_DISCOVER, {});
    const mock = vi.fn(); // any network call here would be a bug
    globalThis.fetch = mock as any;

    const { status, body } = await get(app, AR_MODELS);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.models[0].model).toBe("gpt-6-astra");
    expect(mock).not.toHaveBeenCalled();
  });

  it('fails cleanly when no AgentRouter key is configured', async () => {
    const { status, body } = await post(app, AR_DISCOVER, {});
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/key/i);
  });

  it('relays an upstream 401 as upstream_error (not authentication_error)', async () => {
    await post(app, ADD_KEY, { platform: 'agentrouter', key: 'sk-ar-bad' });
    stubAgentRouter({ error: { message: 'unauthorized client detected' } }, 401);
    const { status, body } = await post(app, AR_DISCOVER, {});
    expect(status).toBe(401);
    expect(body.error.type).toBe('upstream_error');
  });

  it('keeps responses-only gating intact for BOTH custom and built-in platforms', () => {
    // Regression guard: the built-in platform must not have weakened the
    // original custom-host gating (chat path preserved for other hosts).
    expect(usesResponsesUpstream(AR_BASE, 'custom', 'gpt-6-astra')).toBe(true);
    expect(usesResponsesUpstream('https://api.groq.com/openai/v1', 'custom', 'gpt-6-astra')).toBe(false);
    expect(usesResponsesUpstream(AR_BASE, 'openrouter', 'gpt-6-astra')).toBe(false);
    expect(usesResponsesUpstream(AR_BASE, 'agentrouter', 'gpt-6-astra')).toBe(true);
    expect(usesResponsesUpstream('', 'agentrouter', 'gpt-6-astra')).toBe(true);
  });

  it('the three models are requestable through the built-in provider via /responses', async () => {
    let lastUrl = '';
    globalThis.fetch = vi.fn(async (url, _init) => {
      lastUrl = String(url);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'r', status: 'completed', model: 'gpt-6-astra', created_at: 1,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    }) as any;

    const p = resolveProvider('agentrouter') as OpenAICompatProvider;
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6.1-sol']) {
      const out = await p.chatCompletion('k', [{ role: 'user', content: 'hi' }], model);
      expect(lastUrl).toBe(`${AR_BASE}/responses`);
      expect(out._routed_via).toEqual({ platform: 'agentrouter', model });
    }
  });
});
