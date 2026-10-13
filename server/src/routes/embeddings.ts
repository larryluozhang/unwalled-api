import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting, getSetting } from '../db/index.js';
import { logChainConfigChange } from '../lib/chain-audit.js';
import { decrypt, maskKey } from '../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import { resolveCustomEndpointKey } from '../services/custom-endpoint.js';
import {
  listEmbeddingModels,
  getDefaultFamily,
  probeEmbeddingDimensions,
  registerCustomEmbeddingModel,
  EmbeddingsError,
  type EmbeddingModelRow,
} from '../services/embeddings.js';

export const embeddingsRouter = Router();

// Families with their provider chains, for the dashboard Embeddings tab.
embeddingsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare(
      "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
    ).all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );
  const customKeyIds = new Set(
    (db.prepare(
      "SELECT id FROM api_keys WHERE platform = 'custom' AND enabled = 1 AND status IN ('healthy', 'unknown')",
    ).all() as { id: number }[]).map(r => r.id),
  );

  const byFamily = new Map<string, EmbeddingModelRow[]>();
  for (const row of listEmbeddingModels()) {
    const list = byFamily.get(row.family) ?? [];
    list.push(row);
    byFamily.set(row.family, list);
  }

  const defaultFamily = getDefaultFamily();
  res.json({
    defaultFamily,
    families: [...byFamily.entries()].map(([family, rows]) => ({
      family,
      dimensions: rows[0].dimensions,
      maxInputTokens: rows[0].max_input_tokens,
      isDefault: family === defaultFamily,
      providers: rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        priority: r.priority,
        enabled: r.enabled === 1,
        quotaLabel: r.quota_label,
        maxConcurrent: r.max_concurrent ?? null,
        requestTimeoutMs: r.request_timeout_ms ?? null,
        keyCount: r.platform === 'custom' && r.key_id != null
          ? (customKeyIds.has(r.key_id) ? 1 : 0)
          : keyCounts.get(r.platform) ?? 0,
        isCustom: r.platform === 'custom',
      })),
    })),
  });
});

const customEmbeddingSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  family: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
  maxInputTokens: z.number().int().positive().optional(),
});

function decryptExistingKey(row: { encrypted_key: string; iv: string; auth_tag: string } | undefined): string | null {
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

embeddingsRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customEmbeddingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  if (!modelId) {
    res.status(400).json({ error: { message: 'model is required' } });
    return;
  }
  // Optional: NULL means "no opinion". A new model takes its id, and a model
  // already on record keeps the name it has instead of being reset by a submit
  // that simply left the field blank (#704).
  const submittedName = parsed.data.displayName?.trim() || null;
  const family = parsed.data.family?.trim() || modelId;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  const existingKey = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'custom' AND base_url = ?
     LIMIT 1
  `).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
  const probeKey = providedKey ?? decryptExistingKey(existingKey) ?? 'no-key';

  let dimensions: number;
  try {
    dimensions = await probeEmbeddingDimensions(baseUrl, probeKey, modelId);
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({
      error: { message: `custom embedding probe failed: ${err?.message ?? 'unknown error'}` },
    });
    return;
  }

  const upsert = db.transaction(() => {
    // A new secret for a known endpoint is an ADDITIONAL credential, never a
    // replacement for the stored one (#619).
    const { keyId, storedKey: storedKeyForMask } = resolveCustomEndpointKey(db, baseUrl, providedKey, label);
    const { modelDbId } = registerCustomEmbeddingModel(db, {
      keyId,
      modelId,
      displayName: submittedName,
      family,
      dimensions,
      maxInputTokens: parsed.data.maxInputTokens ?? null,
      quotaLabel,
    });
    return { modelDbId, keyId, storedKeyForMask };
  });

  // A family-dimension conflict aborts the transaction, so a rejected submit
  // leaves no half-registered key row behind.
  let result: { modelDbId: number; keyId: number; storedKeyForMask: string };
  try {
    result = upsert();
  } catch (err: any) {
    if (err instanceof EmbeddingsError) {
      // `upstream_error`, never `authentication_error`: this status is relayed
      // from the operator's own endpoint, and a client that reads a bare 401 as
      // "session expired" would sign the operator out for testing a bad key.
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    throw err;
  }
  const storedName = (db.prepare('SELECT display_name FROM embedding_models WHERE id = ?')
    .get(result.modelDbId) as { display_name: string }).display_name;
  res.status(201).json({
    success: true,
    keyId: result.keyId,
    modelDbId: result.modelDbId,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName: storedName,
    family,
    dimensions,
    maskedKey: maskKey(result.storedKeyForMask),
  });
});

const updateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
    // che.32: 并发上限（0/null/省略=不限）
    max_concurrent: z.number().int().min(0).nullable().optional(),
  })).optional(),
});

// che.29: 平台成员注册（此前只能加 custom 端点成员——bge-m3 family 合并这类
// 调整只能进 DB 改）。platform 限 callProvider 已有适配器的平台。
const EMBED_ADAPTER_PLATFORMS = new Set([
  'google', 'siliconflow', 'siliconflow-cn', 'modelscope', 'nvidia',
  'openrouter', 'github', 'sealion', 'cloudflare', 'huggingface', 'cohere',
]);
const memberSchema = z.object({
  platform: z.string(),
  modelId: z.string().min(1),
  family: z.string().optional(),
  displayName: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().nullable().optional(),
  keyId: z.number().int().positive().nullable().optional(),
  quotaLabel: z.string().optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(0).nullable().optional(),
  requestTimeoutMs: z.number().int().min(1000).nullable().optional(),
});

embeddingsRouter.post('/member', (req: Request, res: Response) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId } = parsed.data;
  if (!EMBED_ADAPTER_PLATFORMS.has(platform)) {
    res.status(400).json({ error: { message: `platform '${platform}' has no embedding adapter (supported: ${[...EMBED_ADAPTER_PLATFORMS].join(', ')})` } });
    return;
  }
  const db = getDb();
  const family = parsed.data.family?.trim() || modelId;
  // 目标 family 已有成员时维度必须一致（不同维度混进一条链会静默污染向量库）
  const famDims = db.prepare('SELECT DISTINCT dimensions FROM embedding_models WHERE family = ? AND enabled = 1').all(family) as Array<{ dimensions: number | null }>;
  const existingDims = famDims.map(d => d.dimensions).filter((d): d is number => typeof d === 'number' && d > 0);
  const dimensions = parsed.data.dimensions ?? existingDims[0];
  if (!dimensions) {
    res.status(400).json({ error: { message: `dimensions is required when creating a new family '${family}'` } });
    return;
  }
  if (existingDims.length > 0 && !existingDims.includes(dimensions)) {
    res.status(409).json({ error: { message: `dimension mismatch: family '${family}' is ${existingDims.join('/')}d, got ${dimensions}d` } });
    return;
  }
  const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM embedding_models').get() as { v: number }).v;
  try {
    const r = db.prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id, max_concurrent, request_timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(family, platform, modelId, parsed.data.displayName?.trim() || `${modelId} (${platform}, manual)`, dimensions,
        parsed.data.maxInputTokens ?? null, prio, parsed.data.enabled === false ? 0 : 1,
        parsed.data.quotaLabel?.trim() || 'manual', parsed.data.keyId ?? null,
        parsed.data.maxConcurrent ?? null, parsed.data.requestTimeoutMs ?? null);
    logChainConfigChange('embeddings', 'add-member', `${platform}/${modelId} → family '${family}'`, null,
      { id: r.lastInsertRowid, family, platform, modelId, dimensions, priority: prio }, 'dashboard');
    res.status(201).json({ success: true, id: r.lastInsertRowid, family, platform, modelId, dimensions, priority: prio });
  } catch (err: any) {
    if (String(err?.message ?? '').includes('UNIQUE')) {
      res.status(409).json({ error: { message: `${platform}/${modelId} already registered` } });
      return;
    }
    throw err;
  }
});

// che.29: 改成员的 family 归属（此前只能进 DB 改）
const familyEditSchema = z.object({ family: z.string().min(1) });

embeddingsRouter.put('/:id/family', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  const parsed = familyEditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'family is required' } });
    return;
  }
  const db = getDb();
  const row = db.prepare('SELECT id, platform, model_id, family, dimensions FROM embedding_models WHERE id = ?').get(id) as { id: number; platform: string; model_id: string; family: string; dimensions: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown embedding model ${id}` } });
    return;
  }
  const newFamily = parsed.data.family.trim();
  // 维度一致性闸（与 /member 同规则）
  const famDims = db.prepare('SELECT DISTINCT dimensions FROM embedding_models WHERE family = ? AND enabled = 1 AND id != ?').all(newFamily, id) as Array<{ dimensions: number | null }>;
  const existingDims = famDims.map(d => d.dimensions).filter((d): d is number => typeof d === 'number' && d > 0);
  if (existingDims.length > 0 && row.dimensions && !existingDims.includes(row.dimensions)) {
    res.status(409).json({ error: { message: `dimension mismatch: family '${newFamily}' is ${existingDims.join('/')}d, this model is ${row.dimensions}d` } });
    return;
  }
  db.prepare('UPDATE embedding_models SET family = ? WHERE id = ?').run(newFamily, id);
  logChainConfigChange('embeddings', 'edit-family', `${row.platform}/${row.model_id}: family '${row.family}' → '${newFamily}'`,
    { family: row.family }, { family: newFamily }, 'dashboard');
  res.json({ success: true, id, family: newFamily });
});

embeddingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const db = getDb();

  if (parsed.data.defaultFamily) {
    const exists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ?').get(parsed.data.defaultFamily);
    if (!exists) {
      res.status(400).json({ error: { message: `Unknown family '${parsed.data.defaultFamily}'` } });
      return;
    }
    const prevFamily = getSetting('embeddings_default_family');
    setSetting('embeddings_default_family', parsed.data.defaultFamily);
    // che.29: 默认 family 变更留痕
    logChainConfigChange('embeddings', 'set-default-family', `默认 family: ${prevFamily ?? '(unset)'} → ${parsed.data.defaultFamily}`, prevFamily, parsed.data.defaultFamily, 'dashboard');
  }

  if (parsed.data.providers) {
    // che.29: 变更前快照
    const ids = parsed.data.providers.map(r => r.id);
    const beforeRows = ids.length > 0
      ? db.prepare(`SELECT id, priority, enabled FROM embedding_models WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: number; priority: number; enabled: number }>
      : [];
    const beforeMap = new Map(beforeRows.map(r => [r.id, { priority: r.priority, enabled: r.enabled }]));
    const update = db.prepare('UPDATE embedding_models SET priority = ?, enabled = ?, max_concurrent = COALESCE(?, max_concurrent), request_timeout_ms = COALESCE(?, request_timeout_ms) WHERE id = ?');
    const apply = db.transaction((rows: { id: number; priority: number; enabled: boolean; max_concurrent?: number | null; request_timeout_ms?: number | null }[]) => {
      for (const r of rows) update.run(r.priority, r.enabled ? 1 : 0, r.max_concurrent ?? null, r.request_timeout_ms ?? null, r.id);
    });
    apply(parsed.data.providers);
    // che.29: diff 落审计
    const changed = parsed.data.providers.filter(r => {
      const b = beforeMap.get(r.id);
      return !b || b.priority !== r.priority || b.enabled !== (r.enabled ? 1 : 0);
    });
    if (changed.length > 0) {
      logChainConfigChange('embeddings', 'save-chain', `嵌入链变更 ${changed.length}/${parsed.data.providers.length} 条`,
        Object.fromEntries(changed.map(c => [c.id, beforeMap.get(c.id) ?? null])),
        Object.fromEntries(changed.map(c => [c.id, { priority: c.priority, enabled: c.enabled }])),
        'dashboard');
    }
  }

  res.json({ success: true });
});

embeddingsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT family, key_id FROM embedding_models WHERE id = ? AND platform = 'custom'").get(id) as { family: string; key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom embedding model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM embedding_models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  if (getDefaultFamily() === row.family) {
    const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
    if (replacement) setSetting('embeddings_default_family', replacement.family);
  }
  res.json({ success: true });
});

// Per-family usage: requests today (most embedding quotas are daily/RPM) and
// tokens this calendar month, from the tagged request log.
//
// Deliberately no budget denominator. `models.monthly_token_budget` gives chat
// a real number to divide by; `embedding_models` only carries a free-text
// `quota_label` ("10K neurons/day (shared)", "$0.10/mo credits"), and there is
// no honest conversion from Cloudflare Neurons or dollar credits to tokens. So
// the summary reports what was actually spent and shows each provider's quota
// label verbatim, rather than inventing a ceiling to draw a percentage against.
embeddingsRouter.get('/usage', (_req: Request, res: Response) => {
  const db = getDb();
  const usage = db.prepare(`
    SELECT em.family,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN r.input_tokens ELSE 0 END), 0) AS tokens_month
    FROM embedding_models em
    LEFT JOIN requests r
      ON r.request_type = 'embedding'
     AND r.status = 'success'
     AND r.platform = em.platform
     AND r.model_id = em.model_id
     AND r.created_at >= datetime('now', 'start of month')
    GROUP BY em.family
  `).all() as { family: string; requests_today: number; tokens_month: number }[];

  // One representative provider per family for the legend: the highest-priority
  // enabled row, so the label matches whoever actually serves the family first.
  const meta = db.prepare(`
    SELECT family, platform, quota_label
    FROM embedding_models
    WHERE enabled = 1
    ORDER BY priority ASC
  `).all() as { family: string; platform: string; quota_label: string | null }[];
  const metaByFamily = new Map<string, { platform: string; quota_label: string | null }>();
  for (const m of meta) if (!metaByFamily.has(m.family)) metaByFamily.set(m.family, m);

  const families = usage.map(u => ({
    family: u.family,
    requestsToday: u.requests_today,
    tokensMonth: u.tokens_month,
    platform: metaByFamily.get(u.family)?.platform ?? null,
    quotaLabel: metaByFamily.get(u.family)?.quota_label ?? null,
  }));

  res.json({
    families,
    totalTokensMonth: families.reduce((s, f) => s + f.tokensMonth, 0),
    totalRequestsToday: families.reduce((s, f) => s + f.requestsToday, 0),
  });
});
