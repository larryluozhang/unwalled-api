// Migration: per-member concurrency cap for embedding chains (che.32)
// Created: 2026-10-13
//
// embedding_models.max_concurrent（NULL/0=关闭）——链上每个成员可选配并发上限，
// 闸满即在 family 回退链里溢出到下一路。解决"严格优先级链把洪峰全压到第一家"
// 的队头阻塞（本地单槽 sidecar 被排到 120s 超时的实证），同时适用于云端限频
// 平台（sealion 10rpm、CF 神经元池等）——任何成员都可以在洪峰时让位而不是堵死。

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE embedding_models ADD COLUMN max_concurrent INTEGER;
  `);
}

export function down(db: Db): void {
  db.exec(`
    ALTER TABLE embedding_models DROP COLUMN max_concurrent;
  `);
}
