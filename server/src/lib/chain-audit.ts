import { getDb } from '../db/index.js';

/**
 * che.29: 链配置变更审计日志。
 *
 * 背景：bge-m3 嵌入链 priority 多次"自动变化"，排查成本极高——catalog-sync
 * 覆写、dashboard 拖拽、工作区手工 SQL 三路都会改，但没有任何地方留痕。
 * 此后所有链配置类写操作（fallback / embeddings / media / routing 策略）
 * 在变更成功后落一条审计记录：scope、动作、before/after 摘要、来源。
 *
 * 查询：SELECT * FROM chain_config_audit ORDER BY id DESC;
 */

export type ChainAuditScope = 'fallback' | 'embeddings' | 'media' | 'routing';

type AuditDb = ReturnType<typeof getDb>;

function ensureTable(db: AuditDb): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS chain_config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    before_json TEXT NOT NULL DEFAULT '',
    after_json TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'dashboard',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

/** 截断保护：before/after 各最多 2000 字符，防巨型链撑爆行 */
function clip(v: unknown): string {
  try {
    return JSON.stringify(v ?? null).slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
}

export function logChainConfigChange(
  scope: ChainAuditScope,
  action: string,
  summary: string,
  before: unknown,
  after: unknown,
  source = 'dashboard',
): void {
  try {
    const db = getDb();
    ensureTable(db);
    db.prepare('INSERT INTO chain_config_audit (scope, action, summary, before_json, after_json, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(scope, action, summary.slice(0, 500), clip(before), clip(after), source);
  } catch (e) {
    // 审计日志绝不能阻断主流程
    console.error('[chain-audit] write failed:', e);
  }
}

export interface ChainAuditRow {
  id: number;
  scope: string;
  action: string;
  summary: string;
  before_json: string;
  after_json: string;
  source: string;
  created_at: string;
}

export function listChainConfigAudit(limit = 100): ChainAuditRow[] {
  const db = getDb();
  ensureTable(db);
  return db.prepare('SELECT * FROM chain_config_audit ORDER BY id DESC LIMIT ?').all(limit) as ChainAuditRow[];
}
