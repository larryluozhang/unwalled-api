// Migration: rerank model registry (che.32)
// Created: 2026-10-14
//
// rerank_models：向量重排模型的 family 回退链注册表，与 embedding_models 同构
// （去掉 dimensions——rerank 无向量维度；分数分布跨模型不可比，所以 family 只允许
// 同模型成员）。含 che.32 并发闸 + che.31 行级超时两个成员级可选项。

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rerank_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_concurrent INTEGER,
      request_timeout_ms INTEGER,
      quota_label TEXT NOT NULL DEFAULT '',
      key_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rerank_models_family ON rerank_models(family, priority);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_rerank_models_family;
    DROP TABLE IF EXISTS rerank_models;
  `);
}
