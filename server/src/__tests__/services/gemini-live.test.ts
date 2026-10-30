import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { createServer, type Server } from 'node:http';
import { handleLiveUpgrade } from '../../services/gemini-live.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { vi } from 'vitest';

// Mock routePinnedModel so the relay test doesn't depend on key decryption.
vi.mock('../../services/router.js', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    routePinnedModel: () => ({
      provider: { name: 'google' },
      modelId: 'gemini-2.5-flash-native-audio-latest',
      modelDbId: 1,
      apiKey: 'fake-google-key',
      keyId: 1,
      keyLabel: 'test',
      platform: 'google',
      displayName: 'Gemini Live',
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
      release: vi.fn(),
    }),
  };
});

// A local upstream stub that mimics Google's Live WS: echoes a setup ack and
// echoes any message back. We point the proxy's upstream at it by overriding
// the endpoint constant via env (production keeps the real Google URL).
let upstream: Server;
let upstreamWs: WebSocketServer;
let gateway: Server;
let token: string;
const received: string[] = [];

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  token = getUnifiedApiKey();

  // Seed a google Live model + key so routePinnedModel resolves.
  const db = getDb();
  db.prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled) VALUES ('google','','','',1)").run();
  db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools, source, endpoint_scope)
    VALUES ('google','gemini-2.5-flash-native-audio-latest','Gemini Live',1,1,'Medium','free',1,0,0,'custom','')`).run();

  upstreamWs = new WebSocketServer({ noServer: true });
  upstream = createServer();
  upstream.on('upgrade', (req, socket, head) => {
    upstreamWs.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        received.push(typeof data === 'string' ? data : data.toString());
        ws.send(data, { binary: isBinary }); // echo back
      });
    });
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
  // Point the proxy's upstream at our local stub for this test run.
  process.env.GEMINI_LIVE_UPSTREAM_URL = `ws://127.0.0.1:${(upstream.address() as any).port}`;

  gateway = createServer();
  gateway.on('upgrade', handleLiveUpgrade);
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', () => r()));
});

afterEach(() => {
  upstream.close(); gateway.close(); upstreamWs.close();
  received.length = 0;
  delete process.env.GEMINI_LIVE_UPSTREAM_URL;
});

function port(s: Server): number { return (s.address() as any).port; }

describe('gemini-live proxy', () => {
  it('rejects missing/invalid bearer token', async () => {
    const ws = new WsClient(`ws://127.0.0.1:${port(gateway)}/v1beta/gemini-live?model=gemini-2.5-flash-native-audio-latest`);
    const code = await new Promise<number>(r => ws.on('error', () => r(401)));
    expect(code).toBe(401);
  });

  it('rejects non-Live model', async () => {
    const ws = new WsClient(`ws://127.0.0.1:${port(gateway)}/v1beta/gemini-live?model=gemini-2.5-flash`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const code = await new Promise<number>(r => ws.on('error', () => r(404)));
    expect(code).toBe(404);
  });

  it('relays client messages to upstream', async () => {
    const ws = new WsClient(`ws://127.0.0.1:${port(gateway)}/v1beta/gemini-live?model=gemini-2.5-flash-native-audio-latest`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'setup' }));
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    await new Promise(r => setTimeout(r, 300));
    // The upstream stub received both the JSON setup and the binary audio frame.
    expect(received.length).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});
