// che feed 导出器：把本机审计产出（model_overrides 补丁 + 审计注册的 custom
// 模型）打包成签名 JSON，供桌面版 che-feed-sync 拉取应用。
//
// 设计约束：
//  - 内容零上游数据——overrides 全是本地审计/运维产生的补丁，custom 模型是
//    审计器自行探测注册的；catalog 表（上游策展）一个字都不导出。
//  - 签名覆盖 payload_json 的原始字节（Ed25519），桌面端用仓内钉入的公钥验，
//    不做重序列化，避免键序差异导致验签失败。
//  - 私钥不进数据卷：经 CHE_FEED_KEY_PATH 指向的只读挂载读取。
//
// 运行（容器内，跟在审计 cron 后）：
//   node server/dist/che/feed-export.js
// 环境变量：
//   CHE_FEED_KEY_PATH  签名私钥 PEM（默认 /run/che-feed-key.pem）
//   CHE_FEED_OUT       输出目录（默认 /feed）——写 latest.json + history/
//   CHE_FEED_WRITE=0   只打印摘要不落盘（演练）
import { createHash, sign as edSign, createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, initDb } from '../db/index.js';

interface OverrideRow { platform: string; model_id: string; overrides_json: string }
interface ExtraRow {
  platform: string; model_id: string; display_name: string;
  intelligence_rank: number | null; speed_rank: number | null; size_label: string;
  rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  monthly_token_budget: string; context_window: number | null;
  supports_vision: number; supports_tools: number; endpoint_scope: string;
}

function main(): void {
  const db = initDb(undefined, { ensureDir: false });

  const overrides = (db.prepare('SELECT platform, model_id, overrides_json FROM model_overrides').all() as OverrideRow[])
    .map(r => ({ platform: r.platform, model_id: r.model_id, patch: JSON.parse(r.overrides_json) as Record<string, unknown> }));

  // 审计注册的模型 source='custom'（catalog 行是上游策展，绝不导出）
  const extraModels = (db.prepare(`
    SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
           context_window, supports_vision, supports_tools, endpoint_scope
    FROM models WHERE source = 'custom' AND enabled = 1
  `).all() as ExtraRow[]).map(r => ({
    platform: r.platform, model_id: r.model_id, display_name: r.display_name,
    intelligence_rank: r.intelligence_rank, speed_rank: r.speed_rank, size_label: r.size_label,
    rpm_limit: r.rpm_limit, rpd_limit: r.rpd_limit, tpm_limit: r.tpm_limit, tpd_limit: r.tpd_limit,
    monthly_token_budget: r.monthly_token_budget, context_window: r.context_window,
    supports_vision: !!r.supports_vision, supports_tools: !!r.supports_tools,
    endpoint_scope: r.endpoint_scope,
  }));

  const payload = {
    schema: 1,
    overrides,
    extra_models: extraModels,
  };
  const payloadJson = JSON.stringify(payload);
  const version = `${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}.${createHash('sha256').update(payloadJson).digest('hex').slice(0, 8)}`;

  const keyPath = process.env.CHE_FEED_KEY_PATH ?? '/run/che-feed-key.pem';
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  const signature = edSign(null, Buffer.from(payloadJson, 'utf8'), privateKey).toString('base64');

  const feed = {
    version,
    generated_at: new Date().toISOString(),
    payload_json: payloadJson,
    signature,
  };

  console.log(`feed ${version}: overrides=${overrides.length} extra_models=${extraModels.length}`);
  if (process.env.CHE_FEED_WRITE === '0') {
    console.log('CHE_FEED_WRITE=0 — 演练模式，不落盘');
    return;
  }

  const outDir = process.env.CHE_FEED_OUT ?? '/feed';
  mkdirSync(join(outDir, 'history'), { recursive: true });
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');
  writeFileSync(join(outDir, 'history', `${version}.json`), JSON.stringify(feed, null, 2) + '\n');
  console.log(`已写出 ${join(outDir, 'latest.json')}`);
}

main();
