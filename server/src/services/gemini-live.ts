/**
 * Gemini Live bidirectional proxy (che.39).
 *
 * Gemini Live is a long-lived WebSocket carrying interleaved audio frames and
 * JSON control messages — NOT an HTTP request. This module adds a sidecar
 * WebSocket endpoint that relays the session in both directions:
 *
 *   client (Stack-chan / any WS-capable client, Bearer unified-key)
 *     ->  this gateway  ->  upstream Google  wss://generativelanguage.googleapis.com
 *                              /ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * The upstream Google key is selected and decrypted SERVER-SIDE from the
 * gateway's configured google platform keys — never supplied by the client,
 * never forwarded back. The client speaks the standard Gemini Live protocol
 * unchanged, so the client SDK needs no modification.
 *
 * Upgrade path: client connects with  Authorization: Bearer <unified-key>
 *               GET /v1beta/gemini-live?model=<id>
 *
 * This surface is served on the raw HTTP server 'upgrade' event, NOT through
 * Express routers (which don't see upgrades). It does its own auth + origin
 * checks, per-client connection caps, and one analytics row per session.
 */
import { WebSocketServer, WebSocket as WsWebSocket, default as WebSocketClient } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getDb } from '../db/index.js';
import { routePinnedModel } from './router.js';
import { providerLog } from '../lib/server-logs.js';
import { logRequest } from '../lib/request-log.js';
import { resolveAuth } from '../lib/system-prompt.js';
import { extractApiToken } from '../routes/proxy.js';

// Upstream endpoint — the canonical Gemini Live BidiGenerateContent WS.
// Read lazily so tests can point at a local stub via env after import;
// production always uses the real Google URL.
function upstreamEndpoint(): string {
  return process.env.GEMINI_LIVE_UPSTREAM_URL
    ?? 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
}

// Live-capable models we will proxy. Pinning must be explicit: the normal
// auto chain contains non-Live models that would break the protocol, so we
// refuse anything outside this allowlist rather than silently substituting.
const LIVE_MODELS = new Set([
  'gemini-2.5-flash-native-audio-latest',
  'gemini-2.5-flash-preview-native-audio-dialog',
]);

// Side-channel Live path. Kept off the public Gemini REST surface so it can't
// collide with real Gemini routes.
const LIVE_PATH = '/v1beta/gemini-live';

// Per-IP concurrent Live sessions (a Live session holds an upstream socket +
// an audio pipeline; unbounded sockets would exhaust both).
const MAX_SESSIONS_PER_IP = 4;

const sessionsByIp = new Map<string, number>();

export function liveSessionCountForIp(ip: string): number {
  return sessionsByIp.get(ip) ?? 0;
}

function bumpIp(ip: string, delta: number): void {
  const next = Math.max(0, (sessionsByIp.get(ip) ?? 0) + delta);
  if (next === 0) sessionsByIp.delete(ip);
  else sessionsByIp.set(ip, next);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || 'unknown';
}

function parseLiveUrl(req: IncomingMessage): { model: string } | null {
  const host = (req.headers.host ?? '').trim();
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== LIVE_PATH) return null;
  const q = new URL(req.url ?? '', `http://${host || 'localhost'}`).searchParams;
  const model = (q.get('model') ?? '').trim();
  if (!model) return null;
  return { model };
}

function extractBearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || undefined;
}
function authenticate(req: IncomingMessage): boolean {
  // Accept the unified inference key AND enabled client-profile keys (the same
  // auth surface as /v1/* inference). Dashboard session tokens are NOT accepted
  // here — this is an inference surface, not a dashboard /api surface.
  // Query ?key= is supported for Gemini-native clients (Stack-chan's Go dialer
  // hardcodes `?key=` and sets no Authorization header); header is preferred.
  let token = extractApiToken(req as any);
  if (!token) {
    const q = new URL(req.url ?? '', `http://${(req.headers.host ?? 'localhost')}`).searchParams;
    token = q.get('key')?.trim() || undefined;
  }
  return resolveAuth(token) !== null;
}

function originAllowed(req: IncomingMessage): boolean {
  // Browser exposure: reuse the same-origin posture as the rest of the
  // dashboard. A missing Origin (non-browser client like Stack-chan's Go
  // dialer) is allowed — it never carries a browser ambient authority.
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = (req.headers.host ?? '').trim();
    return o.host === host;
  } catch {
    return false;
  }
}

function destroy(socket: Duplex, code = 400, reason = 'Bad Request'): void {
  // Send a plain HTTP error BEFORE the socket is upgraded. WebSocket clients
  // (gorilla, ws, etc.) surface this as the HTTP status of the failed
  // handshake, which is far more diagnosable than a bare close frame.
  const body = JSON.stringify({ error: { message: reason, type: 'invalid_request' } });
  const head =
    `HTTP/1.1 ${code} ${reason === 'Invalid API key' ? 'Unauthorized' : 'Error'}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n';
  socket.write(head + body);
  socket.destroy();
}

const wss = new WebSocketServer({ noServer: true });

export function handleLiveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = parseLiveUrl(req);
  if (!url) return; // not ours — leave for future handlers; do NOT destroy
  const ip = clientIp(req);

  const reject = (code: number, reason: string) => {
    providerLog('warn', `gemini-live rejected: ${reason}`, { provider: 'google', model: url.model, event: 'live_reject' });
    destroy(socket, code, reason);
  };

  if (!originAllowed(req)) return reject(403, 'Origin not allowed');
  if (!authenticate(req)) return reject(401, 'Invalid API key');
  if (!LIVE_MODELS.has(url.model)) return reject(404, `Model '${url.model}' does not support Live`);
  if (liveSessionCountForIp(ip) >= MAX_SESSIONS_PER_IP) return reject(429, 'Too many Live sessions');

  // Pin the model — restricted to google platform so we never leak a custom
  // endpoint's credential upstream to Google.
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM models WHERE platform = 'google' AND model_id = ? AND enabled = 1",
  ).get(url.model) as { id: number } | undefined;
  if (!row) return reject(404, `Model '${url.model}' is not available`);
  const route = routePinnedModel(row.id);
  if (!route || route.platform !== 'google') {
    providerLog('error', `gemini-live: no google route for ${url.model}`, { provider: 'google', model: url.model, event: 'live_no_route' });
    return reject(503, 'No upstream route');
  }

  bumpIp(ip, +1);
  let released = false;
  const release = () => { if (!released) { released = true; route.release?.(); bumpIp(ip, -1); } };

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    providerLog('info', `gemini-live session opened (${ip}, model=${url.model})`, { provider: 'google', model: url.model, event: 'live_open' });
    relay(clientWs, route.apiKey, url.model, ip, release);
  });
}

function relay(clientWs: WsWebSocket, googleKey: string, model: string, ip: string, release: () => void): void {
  const startedAt = Date.now();
  let upstream: WsWebSocket | null = null;
  let upstreamReady = false;
  let closed = false;
  let inputTokens = 0;
  let outputTokens = 0;

  const finish = (status: 'success' | 'error' | 'canceled', note: string) => {
    if (closed) return;
    closed = true;
    try { clientWs.close(); } catch { /* already closed */ }
    try { upstream?.close(); } catch { /* already closed */ }
    release();
    logRequest('google', model, null, status, inputTokens, outputTokens, Date.now() - startedAt, note, null, null, null, 'gemini-live');
    providerLog(status === 'success' ? 'info' : 'warn', `gemini-live session closed (${status}, ${Date.now() - startedAt}ms, ${note})`, { provider: 'google', model, event: 'live_close' });
  };

  const upstreamUrl = `${upstreamEndpoint()}?key=${encodeURIComponent(googleKey)}`;
  const dialer = new WebSocketClient(upstreamUrl);
  upstream = dialer;

  dialer.on('open', () => {
    upstreamReady = true;
  });

  // client -> upstream (audio frames + JSON). Buffer until upstream is ready
  // so a fast client doesn't lose its setup message.
  const clientBuffer: Array<Buffer | string> = [];
  clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    inputTokens += Math.ceil((typeof data === 'string' ? data.length : data.byteLength) / 4);
    if (upstreamReady && upstream && upstream.readyState === upstream.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      clientBuffer.push(data);
    }
  });
  dialer.on('open', () => {
    for (const m of clientBuffer) upstream?.send(m, { binary: typeof m !== 'string' });
    clientBuffer.length = 0;
  });

  // upstream -> client
  dialer.on('message', (data: Buffer | string, isBinary: boolean) => {
    outputTokens += Math.ceil((typeof data === 'string' ? data.length : data.byteLength) / 4);
    if (clientWs.readyState === clientWs.OPEN) clientWs.send(data, { binary: isBinary });
  });

  dialer.on('close', (code, reason) => {
    finish(code === 1000 ? 'success' : 'error', `upstream close ${code} ${reason?.toString() ?? ''}`.trim());
  });
  dialer.on('error', (err) => finish('error', `upstream ${err.message}`));

  clientWs.on('close', () => finish('success', 'client closed'));
  clientWs.on('error', (err) => finish('error', `client ${err.message}`));
}
