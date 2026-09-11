/**
 * che/model-audit — 模型审计器（che 私有扩展）
 *
 * 运行：node server/dist/che/model-audit.js（一次性容器，凭证只在内存解密）
 *
 * 流程：
 *  1) 活性探测：每个有启用 key 的平台，经本网关 /v1 逐个探测启用的 chat 模型，
 *     分类 ok / congested / cooldown / hard_dead / flaky / timeout。
 *  2) /models diff：找目录外候选（new_candidate）。
 *  3) 候选二级探测：直连厂商 chat/completions 验证免费可调用性，
 *     eligible（ok/congested）者注册进 models(source='custom') + fallback_config。
 *  4) 写回（CHE_AUDIT_WRITE=1 默认开）：
 *     - hard_dead → model_overrides 写 {"enabled":false}（官方补丁通道）
 *     - 候选注册 → models 表 INSERT OR IGNORE + fallback_config
 *  5) 末尾打印 CHANGES_WRITTEN: N（cron 据此决定是否重启网关容器刷新缓存）。
 *
 * 环境变量：
 *  CHE_AUDIT_GATEWAY   网关地址（默认 http://127.0.0.1:3001）
 *  CHE_AUDIT_WRITE     1=写回（默认） 0=只读报告
 *  CHE_AUDIT_PLATFORMS / CHE_AUDIT_MODELS  过滤（逗号分隔）
 */
import { getDb, getUnifiedApiKey, initDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';

const GATEWAY = process.env.CHE_AUDIT_GATEWAY ?? 'http://127.0.0.1:3001';
const WRITE = (process.env.CHE_AUDIT_WRITE ?? '1') !== '0';
const PROBE_TIMEOUT_MS = 25_000;
const PROBE_MAX_TOKENS = 4;
const DISCOVERY_TIMEOUT_MS = 15_000;

type Category =
  | 'ok' | 'congested' | 'cooldown' | 'hard_dead' | 'flaky' | 'timeout' | 'error_other'
  | 'new_candidate' | 'missing_upstream' | 'discovery_failed'
  | 'eligible_ok' | 'eligible_congested' | 'paid_only' | 'not_callable' | 'probe_timeout' | 'probe_error'
  | 'registered' | 'disabled_override' | 'skipped';

const DEFAULT_MODELS_URL: Record<string, string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  groq: 'https://api.groq.com/openai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  modelscope: 'https://api-inference.modelscope.cn/v1/models',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/models',
  radeon: 'https://developer.amd.com.cn/radeon/api/v1/models',
  siliconflow: 'https://api.siliconflow.cn/v1/models',
};

function classifyProbe(status: number, body: string): Category {
  const t = body.toLowerCase();
  if (status === 200) return 'ok';
  if (/all models exhausted|on cooldown|soonest (cooldown )?reset/.test(t)) return 'cooldown';
  if (/429|rate.?limit|too many requests|访问量过大/.test(t)) return 'congested';
  if (/no provider supported|blocked at the project level|no longer available|not found or removed|does not exist|http 404| 404/.test(t)) return 'hard_dead';
  if (/empty completion/.test(t)) return 'flaky';
  if (/timeout|aborted|timed out/.test(t)) return 'timeout';
  return 'error_other';
}

function classifyCandidate(status: number, body: string): Category {
  const t = body.toLowerCase();
  if (status === 200) return 'eligible_ok';
  if (/429|rate.?limit|too many requests|访问量过大/.test(t)) return 'eligible_congested';
  if (/payment|insufficient|balance|quota exceeded|credits?|402|充值|欠费/.test(t)) return 'paid_only';
  if (/no provider supported|blocked|not found|404|does not exist|permission|forbidden|403/.test(t)) return 'not_callable';
  if (/timeout|aborted|timed out/.test(t)) return 'probe_timeout';
  return 'probe_error';
}

async function probeViaGateway(unifiedKey: string, modelId: string) {
  const start = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${unifiedKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    return { category: classifyProbe(res.status, text), detail: text.slice(0, 300), latencyMs: Date.now() - start };
  } catch (err) {
    return { category: 'timeout' as Category, detail: String(err).slice(0, 200), latencyMs: Date.now() - start };
  }
}

async function probeCandidateDirect(platform: string, chatUrl: string, apiKey: string, modelId: string) {
  const start = Date.now();
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    return { category: classifyCandidate(res.status, text), detail: text.slice(0, 200), latencyMs: Date.now() - start };
  } catch (err) {
    return { category: 'probe_timeout' as Category, detail: String(err).slice(0, 150), latencyMs: Date.now() - start };
  }
}

async function listRemoteModels(platform: string, baseUrl: string | null, apiKey: string): Promise<string[] | null> {
  let url = (baseUrl && baseUrl !== 'default' ? baseUrl : DEFAULT_MODELS_URL[platform]) ?? null;
  if (!url) return null;
  if (!url.endsWith('/models')) url = `${url.replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = {};
  let finalUrl = url;
  if (platform === 'google') finalUrl = `${url}?key=${apiKey}`;
  else headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
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
  let changes = 0;
  let rankOffset = 1;

  for (const platform of platforms) {
    const keyRow = keys.find((k) => k.platform === platform)!;
    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    const enabledModels = (
      db.prepare('SELECT model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank').all(platform) as Array<{ model_id: string }>
    ).map((r) => r.model_id).filter((m) => modelFilter.length === 0 || modelFilter.includes(m));

    console.log(`\n=== ${platform}: ${enabledModels.length} 个启用模型 ===`);
    for (const modelId of enabledModels) {
      const r = await probeViaGateway(unified, modelId);
      record(platform, modelId, r.category, r.detail, r.latencyMs);
      bump(r.category);
      console.log(`  [${r.category}] ${modelId}${r.category === 'ok' ? '' : ' — ' + r.detail.split('\n')[0].slice(0, 110)}`);
      if (WRITE && r.category === 'hard_dead') {
        db.prepare("INSERT OR REPLACE INTO model_overrides (platform, model_id, overrides_json, updated_at) VALUES (?, ?, '{\"enabled\":false}', datetime('now'))").run(platform, modelId);
        record(platform, modelId, 'disabled_override', 'model_overrides enabled=false');
        bump('disabled_override');
        changes++;
      }
    }

    // /models diff + 候选二级探测
    try {
      const modelsUrl = (keyRow.base_url && keyRow.base_url !== 'default' ? keyRow.base_url : DEFAULT_MODELS_URL[platform]) ?? null;
      if (!modelsUrl) { console.log(`  (discovery) ${platform}: 无端点，跳过`); continue; }
      const remote = await listRemoteModels(platform, keyRow.base_url, apiKey);
      if (remote === null) continue;
      const local = new Set((db.prepare('SELECT model_id FROM models WHERE platform = ?').all(platform) as Array<{ model_id: string }>).map((r) => r.model_id));
      const remoteSet = new Set(remote);
      const candidates = remote.filter((m) => !local.has(m));
      for (const m of enabledModels) {
        if (!remoteSet.has(m)) { record(platform, m, 'missing_upstream', '目录启用但上游列表无'); bump('missing_upstream'); console.log(`  [missing_upstream] ${m}`); }
      }
      console.log(`  (discovery) ${candidates.length} 个候选，逐一二级探测…`);
      const chatUrl = modelsUrl.replace(/\/models$/, '/chat/completions');
      for (const m of candidates) {
        if (platform === 'google') { record(platform, m, 'skipped', 'google 候选探测未实现'); bump('skipped'); continue; }
        record(platform, m, 'new_candidate', '');
        bump('new_candidate');
        const r = await probeCandidateDirect(platform, chatUrl, apiKey, m);
        record(platform, m, r.category, r.detail, r.latencyMs);
        bump(r.category);
        const eligible = r.category === 'eligible_ok' || r.category === 'eligible_congested';
        console.log(`    [${r.category}] ${m}${eligible ? ' ← 可注册' : ''}`);
        if (WRITE && eligible) {
          const ir = (db.prepare('SELECT COALESCE(MAX(intelligence_rank),0) FROM models').get() as { 'COALESCE(MAX(intelligence_rank),0)': number })['COALESCE(MAX(intelligence_rank),0)'] + rankOffset;
          const sr = (db.prepare('SELECT COALESCE(MAX(speed_rank),0) FROM models').get() as { 'COALESCE(MAX(speed_rank),0)': number })['COALESCE(MAX(speed_rank),0)'] + rankOffset;
          rankOffset++;
          const res = db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
            monthly_token_budget, context_window, enabled, supports_vision, key_id, supports_tools,
            paid_input_per_m, paid_output_per_m, source, endpoint_scope)
            VALUES (?, ?, ?, ?, ?, 'che-audit discovered (unverified quota)', 131072, 1, 0, ?, 0, 0, 0, 'custom', '')`)
            .run(platform, m, `${m} (${platform}, che-audit)`, ir, sr, keyRow.id);
          if (res.changes > 0) {
            const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 FROM fallback_config').get() as { 'COALESCE(MAX(priority),0)+1': number })['COALESCE(MAX(priority),0)+1'];
            db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(res.lastInsertRowid, prio);
            record(platform, m, 'registered', `models id=${res.lastInsertRowid}`);
            bump('registered');
            changes++;
          }
        }
      }
    } catch (err) {
      record(platform, '-', 'discovery_failed', String(err).slice(0, 200));
      bump('discovery_failed');
      console.log(`  [discovery_failed] ${String(err).slice(0, 120)}`);
    }
  }

  console.log('\n===== 汇总 =====');
  for (const [c, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`CHANGES_WRITTEN: ${changes}`);
  console.log(`报告已写入 che_model_audit (run_at=${runAt}, write=${WRITE})`);
}

await main();
