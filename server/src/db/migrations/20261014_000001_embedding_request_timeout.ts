// Migration: per-member request timeout for embedding chains (che.31)
// Created: 2026-10-14
//
// embedding_models.request_timeout_ms（NULL=沿用全局 120s）——本地 sidecar 类
// 成员（零刻 llama.cpp 会死锁假绿）宜调低，让故障在健康探测窗口内快速让位给
// 下一路，而不是把调用方拖进 120s 黑洞。与 max_concurrent（che.32）同为成员级
// 可选项，dashboard 嵌入页逐成员可配。

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE embedding_models ADD COLUMN request_timeout_ms INTEGER;
  `);
}

export function down(db: Db): void {
  db.exec(`
    ALTER TABLE embedding_models DROP COLUMN request_timeout_ms;
  `);
}
