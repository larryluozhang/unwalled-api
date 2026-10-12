import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';

// Per-IP fixed-window rate limiter for the public /v1 proxy (#35, item #6).
//
// The /v1 surface authenticates with the unified API key but has no password
// login like the dashboard does, so without this an attacker who can reach the
// server could brute-force the key or flood upstream providers. This caps how
// many requests a single client IP can make per minute and returns a standard
// OpenAI-shaped 429 once the cap is exceeded.
//
// FreeLLMAPI is a single-user tool, so the default ceiling is generous. Tune it
// with PROXY_RATE_LIMIT_RPM (requests per minute per IP); set it to 0 to turn
// rate limiting off entirely.

const WINDOW_MS = 60_000;
const DEFAULT_RPM = 120;
// Bound the IP map so a flood of distinct (e.g. spoofed) source addresses can't
// grow it without limit; expired entries are pruned opportunistically.
const MAX_TRACKED_IPS = 10_000;

interface WindowState {
  count: number;
  resetAt: number;
}

function parseLimit(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

export function createProxyRateLimiter(rpmLimit?: number) {
  const limit = rpmLimit !== undefined ? Math.floor(Math.max(0, rpmLimit)) : parseLimit();
  const windows = new Map<string, WindowState>();

  return function proxyRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = windows.get(ip);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + WINDOW_MS };
      windows.set(ip, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}

// Per-IP fixed-window rate limiter for the /api/* admin surface.
//
// This is a flood guard, not the brute-force guard: dashboard login already has
// its own per-email lockout (routes/auth.ts), and the one admin endpoint that
// verifies a password — GET /api/keys/export — gets its own much tighter
// limiter mounted in app.ts. The broad cap therefore has to clear normal
// dashboard traffic with room to spare. Opening the dashboard fans out across
// keys, health, models, analytics, settings and profiles, and several of those
// poll, so a single user legitimately spends dozens of requests a minute.
//
// Tune with ADMIN_RATE_LIMIT_RPM (requests per minute per IP); 0 disables it.
const ADMIN_DEFAULT_RPM = 600;

function parseAdminLimit(): number {
  const raw = process.env.ADMIN_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return ADMIN_DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return ADMIN_DEFAULT_RPM;
  return Math.floor(n);
}

export function createAdminRateLimiter(rpm?: number) {
  const limit = rpm !== undefined ? Math.floor(Math.max(0, rpm)) : parseAdminLimit();
  const windows = new Map<string, WindowState>();

  return function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = windows.get(ip);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + WINDOW_MS };
      windows.set(ip, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}

// che.29: Per-CREDENTIAL fixed-window rate limiter for the /v1 proxy.
//
// 背景（429 风暴根因分析）：per-IP 限速把所有同机调用方（MemOS/DeepTutor/
// bookpipeline 共用 172.21.0.1）捆进一个预算，任一方突发就全员撞车。
// 本限速器按调用凭证（/v1/t/:token 的 token 或 Authorization bearer 的哈希）
// 独立开窗，让"MemOS 嵌入洪峰"只烧自己的额度。
//
// PROXY_RATE_LIMIT_KEY_RPM：每凭证每分钟请求数，默认 0=关闭（行为与旧版一致）。
// 与 per-IP 限速器串联使用（各自独立判定，任一触发即 429）。
const KEY_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

function parseKeyLimit(): number {
  const raw = process.env.PROXY_RATE_LIMIT_KEY_RPM;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function credentialIdentity(req: Request): string | null {
  // /v1/t/:token 形态：token 即身份
  const tokenParam = (req.params as Record<string, string | undefined>)?.token;
  if (typeof tokenParam === 'string' && tokenParam.length > 0) {
    return 'tok:' + createHash('sha256').update(tokenParam).digest('hex').slice(0, 16);
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 12) {
    return 'key:' + createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 16);
  }
  return null; // 无凭证请求留给 per-IP 闸
}

export function createPerKeyRateLimiter(rpmLimit?: number) {
  const limit = rpmLimit !== undefined ? Math.floor(Math.max(0, rpmLimit)) : parseKeyLimit();
  const windows = new Map<string, WindowState>();

  return function perKeyRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }
    const identity = credentialIdentity(req);
    if (!identity) {
      next();
      return;
    }
    const now = Date.now();
    let state = windows.get(identity);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + KEY_WINDOW_MS };
      windows.set(identity, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_KEYS) {
      for (const [k, v] of windows) {
        if (now >= v.resetAt) windows.delete(k);
      }
    }

    res.setHeader('X-RateLimit-Key-Limit', String(limit));
    res.setHeader('X-RateLimit-Key-Remaining', String(Math.max(0, limit - state.count)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Per-key rate limit exceeded: more than ${limit} requests per minute for this credential. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }
    next();
  };
}
