/**
 * che/model-audit — 模型审计器 v3（che.4）
 *
 * 相对 v2 新增：
 *  - 配额补全：che/quota-facts.json 静态事实（人工核实过）+ AMD 用量 API 尝试，
 *    经 model_overrides（目录模型，合并写）/ 直写 models 表（custom 模型）落库
 *  - speed_rank 实测：按本轮探测延迟对 ok 模型重排名次（overrides.speedRank）
 *  - quirk 告警：连续两轮 error_other/probe_error/timeout 的模型标记 quirk_suspect 报人工
 *  - 修正：override 写入改为读-合并-写（不再覆盖用户已有选择）
 *
 * 运行：node server/dist/che/model-audit.js（一次性容器，凭证只在内存解密）
 * 环境：CHE_AUDIT_GATEWAY / CHE_AUDIT_WRITE(默认1) / CHE_AUDIT_PLATFORMS / CHE_AUDIT_MODELS
 */
import { getDb, getUnifiedApiKey, initDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { readFileSync } from 'node:fs';

const GATEWAY = process.env.CHE_AUDIT_GATEWAY ?? 'http://127.0.0.1:3001';
const WRITE = (process.env.CHE_AUDIT_WRITE ?? '1') !== '0';
const PROBE_TIMEOUT_MS = 25_000;
const PROBE_MAX_TOKENS = 4;
const DISCOVERY_TIMEOUT_MS = 15_000;

type QuotaFacts = Record<string, { rpm_limit?: number; rpd_limit?: number; tpm_limit?: number; tpd_limit?: number; monthly_token_budget?: string }>;
const DEFAULT_QUOTA_FACTS: QuotaFacts = {
  groq: { rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, tpd_limit: 200000, monthly_token_budget: 'free · 30 RPM / 1K req/day / 8K TPM / 200K tok/day（2026-09-11 控制台限额页实测）' },
  modelscope: { monthly_token_budget: 'free · 2000 req/day account-wide（账号级共享池）' },
  radeon: { rpm_limit: 30, monthly_token_budget: 'free shared · $10/day 成本额度 + 30 RPM（北京时间 0 点重置，官方文档）' },
  mistral: { monthly_token_budget: 'free experiment tier · 共享动态限流（429 属常态，勿判死）' },
  zhipu: { monthly_token_budget: 'free flash tier · 全站拥塞型 429 常见（错峰恢复）' },
};
// 运维可在数据卷放 /app/server/data/che/quota-facts.json 覆盖默认值（免重建镜像）
let QUOTA_FACTS = DEFAULT_QUOTA_FACTS;
try {
  QUOTA_FACTS = { ...DEFAULT_QUOTA_FACTS, ...JSON.parse(readFileSync('/app/server/data/che/quota-facts.json', 'utf8')) as QuotaFacts };
} catch { /* 无覆盖文件，用默认 */ }

type Category =
  | 'ok' | 'congested' | 'cooldown' | 'hard_dead' | 'flaky' | 'timeout' | 'error_other'
  | 'new_candidate' | 'missing_upstream' | 'discovery_failed'
  | 'eligible_ok' | 'eligible_congested' | 'paid_only' | 'not_callable' | 'probe_timeout' | 'probe_error'
  | 'registered' | 'disabled_override' | 'skipped'
  | 'quota_applied' | 'speed_ranked' | 'quirk_suspect' | 'quota_api' | 'quota_api_failed';

const DEFAULT_MODELS_URL: Record<string, string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  groq: 'https://api.groq.com/openai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  modelscope: 'https://api-inference.modelscope.cn/v1/models',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/models',
  radeon: 'https://developer.amd.com.cn/radeon/api/v1/models',
  siliconflow: 'https://api.siliconflow.cn/v1/models',
};

/** 配额事实 → overrides 补丁键名（对齐上游 ModelOverridePatch 的 camelCase） */
const FACT_TO_PATCH: Record<string, string> = {
  rpm_limit: 'rpmLimit', rpd_limit: 'rpdLimit', tpm_limit: 'tpmLimit', tpd_limit: 'tpdLimit',
  monthly_token_budget: 'monthlyTokenBudget',
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

async function probeCandidateDirect(chatUrl: string, apiKey: string, modelId: string) {
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

type Db = ReturnType<typeof getDb>;

/** 读-合并-写 model_overrides（不覆盖用户已有选择） */
function mergeOverride(db: Db, platform: string, modelId: string, patch: Record<string, unknown>): void {
  const row = db.prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?').get(platform, modelId) as { overrides_json: string } | undefined;
  const existing = row ? (JSON.parse(row.overrides_json) as Record<string, unknown>) : {};
  const merged = { ...existing, ...patch };
  db.prepare("INSERT OR REPLACE INTO model_overrides (platform, model_id, overrides_json, updated_at) VALUES (?, ?, ?, datetime('now'))")
    .run(platform, modelId, JSON.stringify(merged));
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
  const okLatencies: Array<{ platform: string; modelId: string; latencyMs: number }> = [];

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
      if (r.category === 'ok') okLatencies.push({ platform, modelId, latencyMs: r.latencyMs });
      console.log(`  [${r.category}] ${modelId}${r.category === 'ok' ? '' : ' — ' + r.detail.split('\n')[0].slice(0, 110)}`);
      if (WRITE && r.category === 'hard_dead') {
        mergeOverride(db, platform, modelId, { enabled: false });
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
      if (candidates.length) console.log(`  (discovery) ${candidates.length} 个候选，逐一二级探测…`);
      const chatUrl = modelsUrl.replace(/\/models$/, '/chat/completions');
      for (const m of candidates) {
        if (platform === 'google') { record(platform, m, 'skipped', 'google 候选探测未实现'); bump('skipped'); continue; }
        record(platform, m, 'new_candidate', '');
        bump('new_candidate');
        const r = await probeCandidateDirect(chatUrl, apiKey, m);
        record(platform, m, r.category, r.detail, r.latencyMs);
        bump(r.category);
        const eligible = r.category === 'eligible_ok' || r.category === 'eligible_congested';
        console.log(`    [${r.category}] ${m}${eligible ? ' ← 可注册' : ''}`);
        if (WRITE && eligible) {
          const ir = (db.prepare('SELECT COALESCE(MAX(intelligence_rank),0) AS v FROM models').get() as { v: number }).v + rankOffset;
          const sr = (db.prepare('SELECT COALESCE(MAX(speed_rank),0) AS v FROM models').get() as { v: number }).v + rankOffset;
          rankOffset++;
          const res = db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
            monthly_token_budget, context_window, enabled, supports_vision, key_id, supports_tools,
            paid_input_per_m, paid_output_per_m, source, endpoint_scope)
            VALUES (?, ?, ?, ?, ?, 'che-audit discovered (unverified quota)', 131072, 1, 0, ?, 0, 0, 0, 'custom', '')`)
            .run(platform, m, `${m} (${platform}, che-audit)`, ir, sr, keyRow.id);
          if (res.changes > 0) {
            const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM fallback_config').get() as { v: number }).v;
            db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(res.lastInsertRowid, prio);
            record(platform, m, 'registered', `models id=${res.lastInsertRowid}`);
            bump('registered');
            changes++;
          }
        }
      }

      // AMD 用量 API（尽力而为）
      if (platform === 'radeon') {
        try {
          const r = await fetch('https://developer.amd.com.cn/radeon/api/profile/model-usage?include_recent=false', {
            headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
          });
          const text = await r.text();
          if (r.ok) { record(platform, '-', 'quota_api', text.slice(0, 400)); bump('quota_api'); console.log(`  [quota_api] ${text.slice(0, 120)}`); }
          else { record(platform, '-', 'quota_api_failed', `HTTP ${r.status}`); bump('quota_api_failed'); }
        } catch (e) { record(platform, '-', 'quota_api_failed', String(e).slice(0, 120)); bump('quota_api_failed'); }
      }
    } catch (err) {
      record(platform, '-', 'discovery_failed', String(err).slice(0, 200));
      bump('discovery_failed');
      console.log(`  [discovery_failed] ${String(err).slice(0, 120)}`);
    }
  }

  // ── ② speed_rank 实测重排 ──
  if (WRITE && okLatencies.length > 0) {
    console.log('\n=== speed_rank 实测重排 ===');
    okLatencies.sort((a, b) => a.latencyMs - b.latencyMs);
    let rank = 1;
    for (const m of okLatencies) {
      const isCustom = (db.prepare("SELECT source FROM models WHERE platform = ? AND model_id = ?").get(m.platform, m.modelId) as { source: string } | undefined)?.source === 'custom';
      if (isCustom) {
        db.prepare('UPDATE models SET speed_rank = ? WHERE platform = ? AND model_id = ?').run(rank, m.platform, m.modelId);
      } else {
        mergeOverride(db, m.platform, m.modelId, { speedRank: rank });
      }
      record(m.platform, m.modelId, 'speed_ranked', `rank=${rank} @ ${m.latencyMs}ms`);
      bump('speed_ranked');
      rank++;
    }
    changes += okLatencies.length;
    console.log(`  重排 ${okLatencies.length} 个模型（按实测延迟，1=最快）`);
  }

  // ── ① 配额事实落库 ──
  if (WRITE) {
    console.log('\n=== 配额事实落库 ===');
    for (const [platform, facts] of Object.entries(QUOTA_FACTS)) {
      if (!platforms.includes(platform)) continue;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(facts)) patch[FACT_TO_PATCH[k]] = v;
      const rows = db.prepare('SELECT model_id, source FROM models WHERE platform = ? AND enabled = 1').all(platform) as Array<{ model_id: string; source: string }>;
      for (const row of rows) {
        if (row.source === 'custom') {
          db.prepare('UPDATE models SET rpm_limit = COALESCE(?, rpm_limit), rpd_limit = COALESCE(?, rpd_limit), tpm_limit = COALESCE(?, tpm_limit), tpd_limit = COALESCE(?, tpd_limit), monthly_token_budget = ? WHERE platform = ? AND model_id = ?')
            .run(facts.rpm_limit ?? null, facts.rpd_limit ?? null, facts.tpm_limit ?? null, facts.tpd_limit ?? null, facts.monthly_token_budget ?? '', platform, row.model_id);
        } else {
          mergeOverride(db, platform, row.model_id, patch);
        }
        record(platform, row.model_id, 'quota_applied', JSON.stringify(patch).slice(0, 150));
        bump('quota_applied');
        changes++;
      }
      console.log(`  ${platform}: ${rows.length} 个模型应用配额事实`);
    }
  }

  // ── ③ quirk 嫌疑告警（连续两轮 400 类错误）──
  {
    const prevRun = (db.prepare('SELECT MAX(run_at) AS v FROM che_model_audit WHERE run_at < ?').get(runAt) as { v: string | null }).v;
    if (prevRun) {
      const suspects = db.prepare(`SELECT cur.platform, cur.model_id, cur.category c1, prev.category c2
        FROM che_model_audit cur JOIN che_model_audit prev
          ON prev.run_at = ? AND prev.platform = cur.platform AND prev.model_id = cur.model_id
        WHERE cur.run_at = ? AND cur.category IN ('error_other','probe_error','timeout')
          AND prev.category IN ('error_other','probe_error','timeout')`).all(prevRun, runAt) as Array<{ platform: string; model_id: string; c1: string; c2: string }>;
      if (suspects.length) {
        console.log('\n=== ⚠️ quirk 嫌疑（连续两轮异常，报人工检视，不自动处置）===');
        for (const s of suspects) {
          record(s.platform, s.model_id, 'quirk_suspect', `连续两轮: ${s.c2} → ${s.c1}`);
          bump('quirk_suspect');
          console.log(`  ${s.platform}/${s.model_id}: ${s.c2} → ${s.c1}`);
        }
      }
    }
  }

  console.log('\n===== 汇总 =====');
  for (const [c, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`CHANGES_WRITTEN: ${changes}`);
  console.log(`报告已写入 che_model_audit (run_at=${runAt}, write=${WRITE})`);
}

await main();
