import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { AUDIT_PLATFORMS_SETTING } from '../../che/audit-settings.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: result };
}

describe('/api/settings/audit', () => {
  let app: Express;
  let token: string;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('returns paid-off defaults and preserves free auditing', async () => {
    getDb().prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled) VALUES ('groq','','','',1), ('siliconflow-cn','','','',1)").run();
    const res = await request(app, 'GET', '/api/settings/audit', undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.platform_overrides.groq).toBe(true);
    expect(res.body.platform_overrides['siliconflow-cn']).toBe(false);
  });

  it('merges partial platform updates and preserves the global gate', async () => {
    const first = await request(app, 'PUT', '/api/settings/audit', { platform_overrides: { 'siliconflow-cn': true, groq: false } }, token);
    expect(first.status).toBe(200);
    expect(first.body.platform_overrides['siliconflow-cn']).toBe(true);
    expect(first.body.platform_overrides.groq).toBe(false);
    const second = await request(app, 'PUT', '/api/settings/audit', { enabled: false }, token);
    expect(second.body.enabled).toBe(false);
    expect(second.body.platform_overrides['siliconflow-cn']).toBe(true);
    expect(second.body.platform_overrides.groq).toBe(false);
    const third = await request(app, 'PUT', '/api/settings/audit', { platform_overrides: { groq: true } }, token);
    expect(third.body.enabled).toBe(false);
    expect(third.body.platform_overrides.groq).toBe(true);
  });

  it('rejects malformed input without changing stored settings', async () => {
    for (const body of [
      { enabled: 'yes' },
      { enabled: true, extra: true },
      { platform_overrides: { 'bad platform': true } },
      { platform_overrides: { groq: null } },
    ]) {
      const res = await request(app, 'PUT', '/api/settings/audit', body, token);
      expect(res.status).toBe(400);
    }
    expect(getDb().prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_PLATFORMS_SETTING)).toBeUndefined();
  });

  it('requires dashboard authentication', async () => {
    const res = await request(app, 'GET', '/api/settings/audit', undefined, 'not-a-token');
    expect(res.status).toBe(401);
  });
});
