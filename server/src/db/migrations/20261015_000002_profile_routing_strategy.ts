// Migration: per-profile routing strategy (che.34-①)
// Created: 2026-10-15
//
// profiles.routing_strategy TEXT NULL（NULL=继承全局 settings.routing_strategy）——
// 每条回退链可选专属排序模式（priority/balanced/smartest/fastest/reliable/custom），
// 如交互链 fastest、批处理链 reliable、Default 链继承全局。

import type { Db } from '../types.js';

export function up(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='routing_strategy'").get();
  if (!has) {
    db.exec(`ALTER TABLE profiles ADD COLUMN routing_strategy TEXT;`);
  }
}

export function down(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='routing_strategy'").get();
  if (has) {
    db.exec(`ALTER TABLE profiles DROP COLUMN routing_strategy;`);
  }
}
