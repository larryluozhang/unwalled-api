// Adaptive per-attempt timeout (che.33-①, opt-in).
//
// 背景：chat 尝试超时历史上是平台级静态值（PROVIDER_TIMEOUT_<PLATFORM>，缺省
// 15s）。慢模型（sail 后台任务制、GLM judge p50 25.8s、思考型隐推理）会被静态
// 短超时误判为失败 → 假故障转移 → 上游重复流量（风暴期放大器）。
//
// 本模块按 platform:model 从 requests 表最近 100 个成功样本算 p95，给超时一个
// 随实测延迟浮动的下限：timeout = clamp(base, p95 × multiplier, cap)。
// 默认完全关闭（adaptive_timeout_enabled=0，与旧版逐字节一致）；开启后样本不足
// （<min_samples）的模型仍走原静态值——新模型不会被错误地放大。
import { getDb, getSetting } from '../db/index.js';

const WINDOW_SAMPLES = 100;
const CACHE_TTL_MS = 60_000;

function numSetting(key: string, fallback: number): number {
  let raw: string | undefined;
  try {
    raw = getSetting(key);
  } catch {
    return fallback; // DB 未就绪（测试/启动早期）：退回默认值，绝不阻断代理热路径
  }
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function adaptiveTimeoutEnabled(): boolean {
  try {
    return getSetting('adaptive_timeout_enabled') === '1';
  } catch {
    return false; // DB 未就绪=未开启，旧行为
  }
}

function multiplier(): number {
  return numSetting('adaptive_timeout_multiplier', 2.5);
}

function capMs(): number {
  return numSetting('adaptive_timeout_cap_ms', 300_000);
}

function minSamples(): number {
  return Math.floor(numSetting('adaptive_timeout_min_samples', 20));
}

const cache = new Map<string, { p95: number | null; expiresAt: number }>();

function p95Of(platform: string, modelId: string): number | null {
  const key = `${platform}:${modelId}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.p95;
  let p95: number | null = null;
  try {
    const rows = getDb().prepare(
      "SELECT latency_ms FROM requests WHERE platform = ? AND model_id = ? AND status = 'success' AND latency_ms > 0 ORDER BY id DESC LIMIT ?",
    ).all(platform, modelId, WINDOW_SAMPLES) as { latency_ms: number }[];
    if (rows.length >= minSamples()) {
      const sorted = rows.map(r => r.latency_ms).sort((a, b) => a - b);
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
  } catch {
    p95 = null; // DB 未就绪：退回静态值，绝不阻断代理热路径
  }
  cache.set(key, { p95, expiresAt: Date.now() + CACHE_TTL_MS });
  return p95;
}

/** 计算某次尝试的自适应超时。enabled=false / 无 modelId / 样本不足 → 原样返回 baseMs。 */
export function adaptiveTimeoutMs(platform: string, modelId: string | undefined, baseMs: number): number {
  if (!adaptiveTimeoutEnabled() || !modelId) return baseMs;
  const p95 = p95Of(platform, modelId);
  if (p95 == null) return baseMs;
  const target = Math.ceil(p95 * multiplier());
  return Math.min(Math.max(baseMs, target), capMs());
}
