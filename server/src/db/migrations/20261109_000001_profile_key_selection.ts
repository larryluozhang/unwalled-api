// Migration: per-profile key-selection strategy (P0 / Magpie alignment)
// Created: 2026-11-09
//
// profiles.key_selection_strategy TEXT NULL（NULL=继承全局 settings.key_selection_strategy）——
// 每条回退链可选专属账号选择策略（auto/least-remaining/smart/pace）。
// smart=快到期先用（临期用尽不浪费）；pace=按配额重置周期动态节流。
// 与 routing_strategy（模型质量排序）正交：routing 排模型，key_selection 排账号。

import type { Db } from '../types.js';

export function up(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='key_selection_strategy'").get();
  if (!has) {
    db.exec(`ALTER TABLE profiles ADD COLUMN key_selection_strategy TEXT;`);
  }
}

export function down(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='key_selection_strategy'").get();
  if (has) {
    db.exec(`ALTER TABLE profiles DROP COLUMN key_selection_strategy;`);
  }
}
