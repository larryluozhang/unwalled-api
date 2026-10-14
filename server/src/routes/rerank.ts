import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting, getSetting } from '../db/index.js';
import { logChainConfigChange } from '../lib/chain-audit.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import {
  listRerankModels,
  getDefaultRerankFamily,
  RerankError,
  type RerankModelRow,
} from '../services/rerank.js';

export const rerankRouter = Router();

// che.32: 重排 family 链管理（dashboard"重排"tab）。结构与嵌入页同构。
rerankRouter.get('/', (_req: Request, res: Response) => {
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

  const byFamily = new Map<string, RerankModelRow[]>();
  for (const row of listRerankModels()) {
    const list = byFamily.get(row.family) ?? [];
    list.push(row);
    byFamily.set(row.family, list);
  }

  const defaultFamily = getDefaultRerankFamily();
  res.json({
    defaultFamily,
    families: [...byFamily.entries()].map(([family, rows]) => ({
      family,
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

// 平台成员注册（platform 限 callProvider 已有适配器的平台）
const RERANK_ADAPTER_PLATFORMS = new Set(['siliconflow', 'siliconflow-cn', 'jina', 'cohere', 'custom']);
const memberSchema = z.object({
  platform: z.string(),
  modelId: z.string().min(1),
  family: z.string().optional(),
  displayName: z.string().optional(),
  keyId: z.number().int().positive().nullable().optional(),
  quotaLabel: z.string().optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(0).nullable().optional(),
  requestTimeoutMs: z.number().int().min(1000).nullable().optional(),
});

rerankRouter.post('/member', (req: Request, res: Response) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId } = parsed.data;
  if (!RERANK_ADAPTER_PLATFORMS.has(platform)) {
    res.status(400).json({ error: { message: `platform '${platform}' has no rerank adapter (supported: ${[...RERANK_ADAPTER_PLATFORMS].join(', ')})` } });
    return;
  }
  const db = getDb();
  const family = parsed.data.family?.trim() || modelId;
  if (platform === 'custom' && parsed.data.keyId == null) {
    res.status(400).json({ error: { message: 'custom 平台成员必须绑定 keyId（用 /custom 端点可连 key 一起建）' } });
    return;
  }
  const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM rerank_models WHERE family = ?').get(family) as { v: number }).v;
  const r = db.prepare(`INSERT INTO rerank_models (family, platform, model_id, display_name, priority, enabled, quota_label, key_id, max_concurrent, request_timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(family, platform, modelId, parsed.data.displayName?.trim() || `${modelId} (${platform}, manual)`, prio,
      parsed.data.enabled === false ? 0 : 1, parsed.data.quotaLabel?.trim() || 'manual', parsed.data.keyId ?? null,
      parsed.data.maxConcurrent ?? null, parsed.data.requestTimeoutMs ?? null);
  logChainConfigChange('rerank', 'add-member', `${platform}/${modelId} → family '${family}'`, null,
    { id: r.lastInsertRowid }, 'dashboard');
  res.json({ success: true, id: Number(r.lastInsertRowid) });
});

// custom 端点连 key 带成员一次建（与嵌入 /custom 同模式，无探测——重排无维度闸）
const customRerankSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  family: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
});

function decryptExistingKey(row: { encrypted_key: string; iv: string; auth_tag: string } | undefined): string | null {
  if (!row) return null;
  try { return decrypt(row.encrypted_key, row.iv, row.auth_tag); } catch { return null; }
}

rerankRouter.post('/custom', (req: Request, res: Response) => {
  const parsed = customRerankSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const db = getDb();
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  const family = parsed.data.family?.trim() || modelId;

  const existingKey = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1",
  ).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;

  let keyId = existingKey?.id ?? null;
  if (!keyId) {
    const providedKey = parsed.data.apiKey?.trim() || 'no-key';
    const enc = encrypt(providedKey);
    const r = db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, base_url, enabled) VALUES ('custom', ?, ?, ?, ?, 'unknown', ?, 1)",
    ).run(parsed.data.label?.trim() || `rerank ${baseUrl}`, enc.encrypted, enc.iv, enc.authTag, baseUrl);
    keyId = Number(r.lastInsertRowid);
  } else if (parsed.data.apiKey?.trim()) {
    const enc = encrypt(parsed.data.apiKey.trim());
    db.prepare('UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = ?')
      .run(enc.encrypted, enc.iv, enc.authTag, keyId);
  }

  const prio = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS v FROM rerank_models WHERE family = ?').get(family) as { v: number }).v;
  const r = db.prepare(`INSERT INTO rerank_models (family, platform, model_id, display_name, priority, enabled, quota_label, key_id)
    VALUES (?, 'custom', ?, ?, ?, 1, ?, ?)`)
    .run(family, modelId, parsed.data.displayName?.trim() || `${modelId} (custom endpoint)`, prio,
      parsed.data.quotaLabel?.trim() || 'custom endpoint', keyId);
  logChainConfigChange('rerank', 'add-custom', `custom/${modelId} @ ${baseUrl} → family '${family}'`, null,
    { id: r.lastInsertRowid, keyId }, 'dashboard');
  res.json({ success: true, id: Number(r.lastInsertRowid), keyId });
});

// 改成员 family 归属
const familyEditSchema = z.object({ family: z.string().min(1) });

rerankRouter.put('/:id/family', (req: Request, res: Response) => {
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
  const row = db.prepare('SELECT id, platform, model_id, family FROM rerank_models WHERE id = ?').get(id) as { id: number; platform: string; model_id: string; family: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown rerank model ${id}` } });
    return;
  }
  const newFamily = parsed.data.family.trim();
  db.prepare('UPDATE rerank_models SET family = ? WHERE id = ?').run(newFamily, id);
  logChainConfigChange('rerank', 'edit-family', `${row.platform}/${row.model_id}: family '${row.family}' → '${newFamily}'`,
    { family: row.family }, { family: newFamily }, 'dashboard');
  res.json({ success: true, id, family: newFamily });
});

const updateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
    max_concurrent: z.number().int().min(0).nullable().optional(),
    request_timeout_ms: z.number().int().min(1000).nullable().optional(),
  })).optional(),
});

rerankRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const db = getDb();
  if (parsed.data.defaultFamily !== undefined) {
    const name = parsed.data.defaultFamily;
    const exists = db.prepare('SELECT 1 FROM rerank_models WHERE family = ?').get(name);
    if (!exists) {
      res.status(400).json({ error: { message: `Unknown family '${name}'` } });
      return;
    }
    setSetting('rerank_default_family', name);
    logChainConfigChange('rerank', 'set-default', `default family → '${name}'`, null, { family: name }, 'dashboard');
  }
  if (parsed.data.providers) {
    const update = db.prepare('UPDATE rerank_models SET priority = ?, enabled = ?, max_concurrent = COALESCE(?, max_concurrent), request_timeout_ms = COALESCE(?, request_timeout_ms) WHERE id = ?');
    const apply = db.transaction((rows: { id: number; priority: number; enabled: boolean; max_concurrent?: number | null; request_timeout_ms?: number | null }[]) => {
      for (const r of rows) update.run(r.priority, r.enabled ? 1 : 0, r.max_concurrent ?? null, r.request_timeout_ms ?? null, r.id);
    });
    apply(parsed.data.providers);
  }
  res.json({ success: true });
});

// custom 成员删除（连孤儿 custom key 一起清）
rerankRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getDb();
  const row = db.prepare("SELECT id, platform, model_id, family, key_id FROM rerank_models WHERE id = ? AND platform = 'custom'").get(id) as { id: number; platform: string; model_id: string; family: string; key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom rerank model ${id}` } });
    return;
  }
  db.prepare('DELETE FROM rerank_models WHERE id = ?').run(id);
  if (row.key_id != null) deleteUnusedCustomEndpointKey(db, row.key_id);
  logChainConfigChange('rerank', 'delete-custom', `custom/${row.model_id} 从 family '${row.family}' 删除`, { id }, null, 'dashboard');
  res.json({ success: true });
});

// 用量（按 family 聚合，复用 requests.request_type='rerank'）
rerankRouter.get('/usage', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.family, COUNT(r.id) AS requestsToday, COALESCE(SUM(r.input_tokens), 0) AS tokensMonth
    FROM rerank_models m
    LEFT JOIN requests r ON r.platform = m.platform AND r.model_id = m.model_id AND r.request_type = 'rerank'
      AND r.created_at > datetime('now', 'start of day')
    GROUP BY m.family
  `).all() as { family: string; requestsToday: number; tokensMonth: number }[];
  const monthRows = db.prepare(`
    SELECT m.family, COALESCE(SUM(r.input_tokens), 0) AS tokensMonth
    FROM rerank_models m
    LEFT JOIN requests r ON r.platform = m.platform AND r.model_id = m.model_id AND r.request_type = 'rerank'
      AND r.created_at > datetime('now', 'start of month')
    GROUP BY m.family
  `).all() as { family: string; tokensMonth: number }[];
  const monthMap = new Map(monthRows.map(r => [r.family, r.tokensMonth]));
  res.json({ families: rows.map(r => ({ family: r.family, requestsToday: r.requestsToday, tokensMonth: monthMap.get(r.family) ?? 0 })) });
});
