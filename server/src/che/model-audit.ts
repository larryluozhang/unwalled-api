/**
 * che/model-audit — 模型审计器（只读报告版，che 私有扩展）
 *
 * 运行：node server/dist/che/model-audit.js
 * 在容器内执行（docker run --network freellmapi_default ...），凭证只在内存解密。
 *
 * 干什么：
 *  1) 活性探测：对每个有启用 key 的平台，经本网关 /v1/chat/completions
 *     逐个探测其启用中的 chat 模型（复用全部 provider 适配器/淬火逻辑），
 *     按错误文本分类 ok / congested / cooldown / hard_dead / flaky / timeout。
 *  2) 新模型发现：用各平台 /models 端点（解密 key 直调）与本地目录 diff，
 *     找出目录外的候选新增（new_candidate）与目录有而上游无的（missing_upstream）。
 *  3) 全部写入 che_model_audit 表并打印汇总。本版本不写回任何改动。
 *
 * 环境变量：
 *  CHE_AUDIT_GATEWAY   网关地址（默认 http://127.0.0.1:3001，容器间跑用容器名）
 *  CHE_AUDIT_PLATFORMS 只审计这些平台（逗号分隔，默认全部有 key 平台）
 *  CHE_AUDIT_MODELS    只探测这些 model_id（逗号分隔，默认该平台全部启用模型）
 */
import { getDb, getUnifiedApiKey, initDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';

const GATEWAY = process.env.CHE_AUDIT_GATEWAY ?? 'http://127.0.0.1:3001';
const PROBE_TIMEOUT_MS = 25_000;
const PROBE_MAX_TOKENS = 4;
const DISCOVERY_TIMEOUT_MS = 15_000;

type Category = 'ok' | 'congested' | 'cooldown' | 'hard_dead' | 'flaky' | 'timeout' | 'error_other' | 'new_candidate' | 'missing_upstream' | 'discovery_failed';

/** 各平台 OpenAI 式 /models 端点（api_keys.base_url='default' 时用）。google 走 AI Studio 形态。 */
const DEFAULT_MODELS_URL: Record<string, string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  groq: 'https://api.groq.com/openai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  modelscope: 'https://api-inference.modelscope.cn/v1/models',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/models',
  radeon: 'https://developer.amd.com.cn/radeon/api/v1/models',
};

function classify(status: number, body: string): Category {
  const t = body.toLowerCase();
  if (status === 200) return 'ok';
  if (/all models exhausted|on cooldown|soonest reset/.test(t)) return 'cooldown';
  if (/no provider supported|blocked at the project level|no longer available|does not exist|not found|404|no enabled\+healthy/.test(t)) return 'hard_dead';
  if (/429|rate.?limit|too many requests|访问量过大/.test(t)) return 'congested';
  if (/empty completion/.test(t)) return 'flaky';
  if (/timeout|aborted|timed out/.test(t)) return 'timeout';
  return 'error_other';
}

async function probeModel(unifiedKey: string, modelId: string): Promise<{ category: Category; detail: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${unifiedKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    const latencyMs = Date.now() - start;
    if (res.ok) return { category: 'ok', detail: `HTTP ${res.status}`, latencyMs };
    return { category: classify(res.status, text), detail: text.slice(0, 300), latencyMs };
  } catch (err) {
    return { category: 'timeout', detail: String(err).slice(0, 200), latencyMs: Date.now() - start };
  }
}

async function listRemoteModels(platform: string, baseUrl: string | null, apiKey: string): Promise<string[] | null> {
  const url = (baseUrl && baseUrl !== 'default' ? baseUrl : DEFAULT_MODELS_URL[platform]) ?? null;
  if (!url) return null;
  const headers: Record<string, string> = platform === 'google' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
  const res = await fetch(url.endsWith('/models') ? url : `${url.replace(/\/$/, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
  if (Array.isArray(data.data)) return data.data.map((m) => m.id).filter((x): x is string => Boolean(x));
  if (Array.isArray(data.models)) return data.models.map((m) => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  return [];
}

async function main(): Promise<void> {
  const db = initDb(undefined, { ensureDir: false });
  db.prepare(`CREATE TABLE IF NOT EXISTS che_model_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    platform TEXT NOT NULL,
    model_id TEXT NOT NULL,
    category TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER
  )`).run();
  const runAt = new Date().toISOString();
  const ins = db.prepare('INSERT INTO che_model_audit (run_at, platform, model_id, category, detail, latency_ms) VALUES (?, ?, ?, ?, ?, ?)');
  const record = (platform: string, modelId: string, category: Category, detail = '', latencyMs: number | null = null) =>
    ins.run(runAt, platform, modelId, category, detail, latencyMs);

  const unified = getUnifiedApiKey();
  const platformFilter = (process.env.CHE_AUDIT_PLATFORMS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const modelFilter = (process.env.CHE_AUDIT_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const keys = db
    .prepare("SELECT id, platform, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE enabled = 1 ORDER BY platform")
    .all() as Array<{ id: number; platform: string; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null }>;
  const platforms = [...new Set(keys.map((k) => k.platform))].filter((p) => platformFilter.length === 0 || platformFilter.includes(p));

  const summary: Record<string, number> = {};
  const bump = (c: Category) => { summary[c] = (summary[c] ?? 0) + 1; };

  for (const platform of platforms) {
    const keyRow = keys.find((k) => k.platform === platform)!;
    const enabledModels = (
      db.prepare('SELECT model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank').all(platform) as Array<{ model_id: string }>
    ).map((r) => r.model_id).filter((m) => modelFilter.length === 0 || modelFilter.includes(m));

    console.log(`\n=== ${platform}: ${enabledModels.length} 个启用模型待探测 ===`);
    for (const modelId of enabledModels) {
      const r = await probeModel(unified, modelId);
      record(platform, modelId, r.category, r.detail, r.latencyMs);
      bump(r.category);
      console.log(`  [${r.category}] ${modelId} (${r.latencyMs}ms)${r.category === 'ok' ? '' : ' — ' + r.detail.split('\n')[0].slice(0, 120)}`);
    }

    // /models diff
    try {
      const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
      const remote = await listRemoteModels(platform, keyRow.base_url, apiKey);
      if (remote === null) {
        console.log(`  (discovery) ${platform}: 无默认 /models 端点，跳过`);
        continue;
      }
      const local = new Set((db.prepare('SELECT model_id FROM models WHERE platform = ?').all(platform) as Array<{ model_id: string }>).map((r) => r.model_id));
      const remoteSet = new Set(remote);
      for (const m of remote) {
        if (!local.has(m)) { record(platform, m, 'new_candidate', '上游有而目录无'); bump('new_candidate'); console.log(`  [new_candidate] ${m}`); }
      }
      for (const m of enabledModels) {
        if (!remoteSet.has(m)) { record(platform, m, 'missing_upstream', '目录启用但上游列表无'); bump('missing_upstream'); console.log(`  [missing_upstream] ${m}`); }
      }
    } catch (err) {
      record(platform, '-', 'discovery_failed', String(err).slice(0, 200));
      bump('discovery_failed');
      console.log(`  [discovery_failed] ${String(err).slice(0, 120)}`);
    }
  }

  console.log('\n===== 汇总 =====');
  for (const [c, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`报告已写入 che_model_audit (run_at=${runAt})`);
}

await main();
