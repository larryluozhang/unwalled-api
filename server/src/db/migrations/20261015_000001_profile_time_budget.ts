// Migration: per-profile fallback time budget (che.33-②)
// Created: 2026-10-15
//
// profiles.time_budget_ms（NULL=沿用全局 fallback_time_budget_ms/45s）——交互式链
// （如 auto:memos-judge）宜短（15-20s 快失败），批处理链（如 auto:deeptutor）宜长
// （120s 等得起）。解决全局 45s 预算与客户端超时不匹配的重复流量问题。

import type { Db } from '../types.js';

export function up(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='time_budget_ms'").get();
  if (!has) {
    db.exec(`ALTER TABLE profiles ADD COLUMN time_budget_ms INTEGER;`);
  }
}

export function down(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='time_budget_ms'").get();
  if (has) {
    db.exec(`ALTER TABLE profiles DROP COLUMN time_budget_ms;`);
  }
}
