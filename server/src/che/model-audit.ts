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
  siliconflow: 'https://api.siliconflow.com/v1/models',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3/models',
  qianfan: 'https://qianfan.baidubce.com/v2/models',
  xfyun: 'https://spark-api-open.xf-yun.com/v1/models',
  longcat: 'https://api.longcat.chat/openai/v1/models',
  moonshot: 'https://api.moonshot.cn/v1/models',
};

type ModelKind = 'chat' | 'embedding' | 'transcription' | 'tts' | 'ocr' | 'image' | 'moderation' | 'realtime';

/** 按模型名粗判类型（决定探测端点与注册去向） */
function kindOf(modelId: string): ModelKind {
  const t = modelId.toLowerCase();
  if (/embed/.test(t)) return 'embedding';
  if (/whisper|transcribe/.test(t)) return 'transcription';
  if (/voxtral.*tts|orpheus|(^|[^a-z])tts([^a-z]|$)/.test(t)) return 'tts';
  if (/voxtral/.test(t)) return 'transcription';
  if (/ocr/.test(t)) return 'ocr';
  if (/moderation|prompt-guard|safeguard|guard-/.test(t)) return 'moderation';
  if (/realtime/.test(t)) return 'realtime';
  if (/image|flux|diffusion|dall-e|seedream|imagen/.test(t)) return 'image';
  return 'chat';
}

/** 上游已实现的 embeddings/audio 适配器平台（以目录现存 embedding_models/media_models 平台为准） */
const EMBEDDING_ADAPTERS = new Set(['google', 'nvidia', 'sealion', 'cloudflare', 'openrouter', 'huggingface']);
const MEDIA_ADAPTERS = new Set(['cloudflare', 'google', 'groq']);

/** 0.5 秒 16kHz 静音 WAV（转写探测用，几乎零成本） */
function tinyWav(): Buffer {
  const sampleRate = 16000;
  const dataSize = Math.floor(sampleRate * 0.5) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

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
  if (status === 200) return 'eligible_ok';
  // che.8 加固（9/18 假注册事故）：先用权威错误码判死刑，再看拥塞信号。
  // 旧实现把 429 正则放在 not-found 之前，且对"整段 body（含 request id 十六进制串）"
  // 做正则，曾把两条 volcengine NotFound 误判为 eligible_congested 并注册进库。
  // 1) JSON error.code 是权威信号，优先于一切正则
  let code = '';
  try {
    const j = JSON.parse(body) as { error?: { code?: string }; code?: string };
    code = (j.error?.code ?? j.code ?? '').toLowerCase();
  } catch { /* 非 JSON，走正则 */ }
  if (/notfound|not_found|notopen|doesnotexist|invalidendpoint|invalidparameter|invalidmodel/.test(code)) return 'not_callable';
  if (/payment|balance|insufficient|quotaexceeded|arrears|欠费/.test(code)) return 'paid_only';
  if (/ratelimit|throttl|toomanyrequests/.test(code)) return 'eligible_congested';
  // 2) 正则前剥掉 request id / trace id 十六进制串，杜绝 "429" 之类的假命中
  const t = body.toLowerCase().replace(/(request[_ ]?id|trace[_ ]?id)[:：]?\s*[0-9a-f-]{16,}/g, '');
  if (/no provider supported|blocked|not ?found|404|does not exist|has not activated|model not open|permission|forbidden|403/.test(t)) return 'not_callable';
  if (/payment|insufficient|balance|quota exceeded|credits?|402|充值|欠费/.test(t)) return 'paid_only';
  if (/429|rate.?limit|too many requests|访问量过大/.test(t)) return 'eligible_congested';
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

async function probeEmbedding(embedUrl: string, apiKey: string, modelId: string) {
  const start = Date.now();
  try {
    const res = await fetch(embedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, input: 'ping' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    let dims = 0;
    if (res.ok) {
      try {
        const d = JSON.parse(text) as { data?: Array<{ embedding?: number[] }> };
        dims = d.data?.[0]?.embedding?.length ?? 0;
      } catch { /* 维度解析失败不致命 */ }
    }
    return { category: res.ok ? ('eligible_ok' as Category) : classifyCandidate(res.status, text), detail: text.slice(0, 200), latencyMs: Date.now() - start, dimensions: dims };
  } catch (err) {
    return { category: 'probe_timeout' as Category, detail: String(err).slice(0, 150), latencyMs: Date.now() - start, dimensions: 0 };
  }
}

async function probeTranscription(asrUrl: string, apiKey: string, modelId: string) {
  const start = Date.now();
  try {
    const form = new FormData();
    form.append('model', modelId);
    form.append('file', new Blob([tinyWav()], { type: 'audio/wav' }), 'ping.wav');
    const res = await fetch(asrUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    return { category: res.ok ? ('eligible_ok' as Category) : classifyCandidate(res.status, text), detail: text.slice(0, 200), latencyMs: Date.now() - start };
  } catch (err) {
    return { category: 'probe_timeout' as Category, detail: String(err).slice(0, 150), latencyMs: Date.now() - start };
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
      if (kindOf(modelId) !== 'chat') {
        console.log(`  [skipped] ${modelId} — 非 chat 类型(${kindOf(modelId)})，不属本表探测范围`);
        record(platform, modelId, 'skipped', `非 chat 类型(${kindOf(modelId)})`);
        bump('skipped');
        continue;
      }
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
      if (candidates.length) console.log(`  (discovery) ${candidates.length} 个候选，按类型分流探测…`);
      const chatUrl = modelsUrl.replace(/\/models$/, '/chat/completions');
      const embedUrl = modelsUrl.replace(/\/models$/, '/embeddings');
      const asrUrl = modelsUrl.replace(/\/models$/, '/audio/transcriptions');
      for (const m of candidates) {
        if (platform === 'google') { record(platform, m, 'skipped', 'google 候选探测未实现'); bump('skipped'); continue; }
        record(platform, m, 'new_candidate', '');
        bump('new_candidate');
        const kind = kindOf(m);
        if (kind !== 'chat' && kind !== 'embedding' && kind !== 'transcription') {
          record(platform, m, 'skipped', `非 chat 类型(${kind})，v5 暂不探测`);
          bump('skipped');
          console.log(`    [skipped] ${m} (${kind})`);
          continue;
        }
        const r = kind === 'embedding'
          ? await probeEmbedding(embedUrl, apiKey, m)
          : kind === 'transcription'
            ? await probeTranscription(asrUrl, apiKey, m)
            : await probeCandidateDirect(chatUrl, apiKey, m);
        record(platform, m, r.category, r.detail, r.latencyMs);
        bump(r.category);
        const eligible = r.category === 'eligible_ok' || r.category === 'eligible_congested';
        console.log(`    [${r.category}] ${m} (${kind})${eligible ? ' ← 可注册' : ''}`);
        if (WRITE && eligible) {
          if (kind === 'embedding') {
            if (!EMBEDDING_ADAPTERS.has(platform)) {
              record(platform, m, 'skipped', `上游无 ${platform} 的 embeddings 适配器，不注册`);
              bump('skipped');
              console.log(`    [skipped] ${m} — 上游无 embeddings 适配器`);
              continue;
            }
            const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM embedding_models').get() as { v: number }).v;
            const dims = 'dimensions' in r && typeof r.dimensions === 'number' ? r.dimensions : 0;
            const res = db.prepare(`INSERT OR IGNORE INTO embedding_models (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
              VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 'che-audit discovered', ?)`)
              .run(m, platform, m, `${m} (${platform}, che-audit)`, dims || 1024, prio, keyRow.id);
            if (res.changes > 0) { record(platform, m, 'registered', `embedding_models id=${res.lastInsertRowid} dims=${dims}`); bump('registered'); changes++; }
            continue;
          }
          if (kind === 'transcription') {
            if (!MEDIA_ADAPTERS.has(platform)) {
              record(platform, m, 'skipped', `上游无 ${platform} 的 audio 适配器，不注册`);
              bump('skipped');
              console.log(`    [skipped] ${m} — 上游无 audio 适配器`);
              continue;
            }
            const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM media_models').get() as { v: number }).v;
            const res = db.prepare(`INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
              VALUES (?, ?, ?, 'transcription', ?, 1, 'che-audit discovered', ?)`)
              .run(platform, m, `${m} (${platform}, che-audit)`, prio, keyRow.id);
            if (res.changes > 0) { record(platform, m, 'registered', `media_models id=${res.lastInsertRowid} modality=transcription`); bump('registered'); changes++; }
            continue;
          }
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
      const suspects = (db.prepare(`SELECT cur.platform, cur.model_id, cur.category c1, prev.category c2
        FROM che_model_audit cur JOIN che_model_audit prev
          ON prev.run_at = ? AND prev.platform = cur.platform AND prev.model_id = cur.model_id
        WHERE cur.run_at = ? AND cur.category IN ('error_other','probe_error','timeout')
          AND prev.category IN ('error_other','probe_error','timeout')`).all(prevRun, runAt) as Array<{ platform: string; model_id: string; c1: string; c2: string }>)
        .filter((s) => kindOf(s.model_id) === 'chat');
      if (suspects.length) {
        console.log('\n=== ⚠️ quirk 嫌疑（连续两轮异常，报人工检视，不自动处置）===');
        for (const s of suspects) {
          record(s.platform, s.model_id, 'quirk_suspect', `连续两轮: ${s.c2} → ${s.c1}`);
          bump('quirk_suspect');
          console.log(`  ${s.platform}/${s.model_id}: ${s.c2} → ${s.c1}`);
          // 同步进 server_logs —— 仪表盘「日志」页可见（warn 级，只报不扰）
          const logId = (db.prepare('SELECT COALESCE(MAX(id),0)+1 AS v FROM server_logs').get() as { v: number }).v;
          db.prepare("INSERT INTO server_logs (id, level, source, provider, model, event, request_id, message, created_at_ms) VALUES (?, 'warn', 'che-audit', ?, ?, 'quirk_suspect', NULL, ?, ?)")
            .run(logId, s.platform, s.model_id, `[che-audit] quirk 嫌疑：连续两轮探测异常（${s.c2} → ${s.c1}），请人工检视，未自动处置`, Date.now());
          changes++;
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
