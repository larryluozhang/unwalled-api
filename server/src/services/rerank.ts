// Rerank routing — mirrors services/embeddings.ts. Failover only walks providers
// serving the same family (same reranker model): relevance score distributions
// are not comparable across models, so cross-model failover would silently
// scramble ranking semantics.
//
// Request/response shape follows the SiliconFlow/Jina de-facto standard:
//   POST /v1/rerank { model, query, documents[], top_n? }
//   → { results: [{ index, relevance_score, document? }], usage? }
// Cohere v2 differs slightly (texts/return_documents) and is mapped in its adapter.
import { getDb, getSetting } from '../db/index.js';
import { getClientContext } from '../lib/client-context.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';

export interface RerankModelRow {
  id: number;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  priority: number;
  enabled: number;
  max_concurrent: number | null;
  request_timeout_ms: number | null;
  quota_label: string;
  key_id: number | null;
}

export interface RerankResultItem {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

export interface RerankResult {
  family: string;
  platform: string;
  modelId: string;
  results: RerankResultItem[];
  inputTokens: number;
}

export class RerankError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function listRerankModels(): RerankModelRow[] {
  return getDb().prepare(
    'SELECT * FROM rerank_models ORDER BY family, priority',
  ).all() as RerankModelRow[];
}

export function getDefaultRerankFamily(): string {
  return getSetting('rerank_default_family') ?? 'BAAI/bge-reranker-v2-m3';
}

/** Map the request's `model` to a family: 'auto'/empty → default; a family
 * name → itself; a provider model id → its family. */
export function resolveRerankFamily(model: string | undefined): string | null {
  if (!model || model === 'auto') return getDefaultRerankFamily();
  const rows = listRerankModels();
  if (rows.some(r => r.family === model)) return model;
  const byModelId = rows.find(r => r.model_id === model);
  return byModelId?.family ?? null;
}

interface ProviderCredential {
  id: number;
  key: string | null;
  baseUrl: string | null;
}

function getProviderCredential(row: RerankModelRow): ProviderCredential | null {
  if (row.key_id != null) {
    const keyRow = getDb().prepare(
      "SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1",
    ).get(row.key_id) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
    if (!keyRow) return null;
    try {
      return { id: keyRow.id, key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag), baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null };
    } catch { return null; }
  }
  if (row.platform === 'custom') return null;

  const keyRow = getDb().prepare(
    "SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY RANDOM() LIMIT 1",
  ).get(row.platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
  if (!keyRow) return null;
  try {
    return { id: keyRow.id, key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag), baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null };
  } catch { return null; }
}

const DEFAULT_RERANK_TIMEOUT_MS = 60_000;

// che.32: rerank 链 per-member 并发闸（与嵌入链同款客户可选项）。
const rerankInflight = new Map<string, number>();

function rerankConcurrencyCap(row: RerankModelRow): number {
  return row.max_concurrent ?? 0;
}

interface ProviderCallResult {
  results: RerankResultItem[];
  inputTokens: number | null;
}

/** documents may be plain strings or { text } objects (Cohere style). */
export type RerankDocument = string | { text?: string };

function docText(d: RerankDocument): string {
  return typeof d === 'string' ? d : (d.text ?? '');
}

async function callProvider(
  row: RerankModelRow,
  credential: ProviderCredential,
  query: string,
  documents: RerankDocument[],
  topN: number | undefined,
): Promise<ProviderCallResult> {
  const key = credential.key ?? 'no-key';
  const timeoutMs = row.request_timeout_ms ?? DEFAULT_RERANK_TIMEOUT_MS;
  const docs = documents.map(docText);
  const top = topN ?? documents.length;
  switch (row.platform) {
    case 'custom': {
      if (!credential.baseUrl) throw new RerankError('custom rerank provider is missing base_url', 500);
      // 先试 SiliconFlow/Jina 形态的 /rerank；404 则试 llama.cpp 的 /reranking
      let r = await proxyFetch(`${credential.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, query, documents: docs, top_n: top }),
        signal: AbortSignal.timeout(timeoutMs),
      }, row.platform, 'rerank', timeoutMs);
      if (r.status === 404) {
        r = await proxyFetch(`${credential.baseUrl}/reranking`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, documents: docs }),
          signal: AbortSignal.timeout(timeoutMs),
        }, row.platform, 'rerank', timeoutMs);
      }
      if (!r.ok) throw new RerankError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      return normalizeResults(await r.json(), docs.length);
    }
    case 'siliconflow':
    case 'siliconflow-cn':
    case 'jina': {
      const base = row.platform === 'siliconflow-cn' ? 'https://api.siliconflow.cn/v1'
        : row.platform === 'jina' ? 'https://api.jina.ai/v1'
        : 'https://api.siliconflow.com/v1';
      const r = await proxyFetch(`${base}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, query, documents: docs, top_n: top }),
        signal: AbortSignal.timeout(timeoutMs),
      }, row.platform, 'rerank', timeoutMs);
      if (!r.ok) throw new RerankError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      return normalizeResults(await r.json(), docs.length);
    }
    case 'cohere': {
      const r = await proxyFetch('https://api.cohere.com/v2/rerank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, query, documents: docs, top_n: top, return_documents: true }),
        signal: AbortSignal.timeout(timeoutMs),
      }, row.platform, 'rerank', timeoutMs);
      if (!r.ok) throw new RerankError(`cohere ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      return normalizeResults(await r.json(), docs.length);
    }
    default:
      throw new RerankError(`no rerank adapter for platform '${row.platform}'`, 501);
  }
}

/** Normalize SiliconFlow/Jina/Cohere/llama.cpp response shapes into one list. */
function normalizeResults(j: any, docCount: number): ProviderCallResult {
  const raw: any[] = Array.isArray(j) ? j : (j?.results ?? []);
  const results: RerankResultItem[] = raw.map((it: any) => ({
    index: Number(it.index ?? 0),
    relevance_score: Number(it.relevance_score ?? it.score ?? 0),
    ...(it.document?.text !== undefined ? { document: { text: String(it.document.text) } }
      : typeof it.document === 'string' ? { document: { text: it.document } } : {}),
  })).filter(it => it.index >= 0 && it.index < docCount);
  if (results.length === 0 && docCount > 0) throw new RerankError('upstream returned no rerank results', 502);
  const usageTokens = typeof j?.meta?.tokens?.input_tokens === 'number' ? j.meta.tokens.input_tokens
    : typeof j?.usage?.total_tokens === 'number' ? j.usage.total_tokens : null;
  return { results, inputTokens: usageTokens };
}

function estimateRerankTokens(query: string, documents: RerankDocument[]): number {
  return Math.ceil((query.length + documents.reduce((a, d) => a + docText(d).length, 0)) / 4);
}

function logRerankRequest(
  row: RerankModelRow,
  keyId: number | null,
  status: 'success' | 'error',
  inputTokens: number,
  latencyMs: number,
  error: string | null,
): void {
  try {
    const client = getClientContext();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'rerank', ?, ?, ?)
    `).run(row.platform, row.model_id, keyId, status, inputTokens, latencyMs, error, client.ip, client.userAgent, client.agent);
  } catch (e) {
    console.error('Failed to log rerank request:', e);
  }
}

/** Rerank `documents` against `query` through the family's provider chain.
 * `model` may be 'auto'/empty (default family), a family name, or a provider
 * model id. Failover walks the family chain by priority; per-member
 * max_concurrent caps overflow to the next member instead of queueing. */
export async function runRerank(
  model: string | undefined,
  query: string,
  documents: RerankDocument[],
  topN?: number,
): Promise<RerankResult> {
  if (!query.trim()) throw new RerankError('query is required', 400);
  if (documents.length === 0) throw new RerankError('documents is required', 400);
  if (documents.length > 1000) throw new RerankError('documents exceeds the 1000-item ceiling', 400);

  const family = resolveRerankFamily(model);
  if (!family) {
    throw new RerankError(
      `Unknown rerank model '${model}'. Use 'auto', a family name, or a provider model id.`, 400,
    );
  }

  const chain = (getDb().prepare(
    'SELECT * FROM rerank_models WHERE family = ? AND enabled = 1 ORDER BY priority',
  ).all(family) as RerankModelRow[]);
  if (chain.length === 0) {
    throw new RerankError(`No enabled providers for rerank family '${family}'.`, 503);
  }

  let lastError: RerankError | null = null;
  for (const row of chain) {
    const credential = getProviderCredential(row);
    if (!credential) continue;
    const gateCap = rerankConcurrencyCap(row);
    const gateKey = String(row.id);
    const gateCur = rerankInflight.get(gateKey) ?? 0;
    if (gateCap > 0 && gateCur >= gateCap) {
      lastError = new RerankError(`provider '${row.platform}' at concurrency cap (${gateCap}), overflowing to next`, 503);
      continue;
    }
    if (gateCap > 0) rerankInflight.set(gateKey, gateCur + 1);
    const started = Date.now();
    try {
      const out = await callProvider(row, credential, query, documents, topN);
      const tokens = out.inputTokens ?? estimateRerankTokens(query, documents);
      logRerankRequest(row, credential.id, 'success', tokens, Date.now() - started, null);
      return {
        family,
        platform: row.platform,
        modelId: row.model_id,
        results: out.results,
        inputTokens: tokens,
      };
    } catch (err: any) {
      const e = err instanceof RerankError ? err : new RerankError(String(err?.message ?? err), 502);
      logRerankRequest(row, credential.id, 'error', 0, Date.now() - started, e.message.slice(0, 300));
      lastError = e;
      // fall through to the next provider in the family
    } finally {
      if (gateCap > 0) rerankInflight.set(gateKey, Math.max(0, (rerankInflight.get(gateKey) ?? 1) - 1));
    }
  }

  throw new RerankError(
    `All providers for rerank family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && (lastError.status === 429 || lastError.status === 400) ? lastError.status : 502,
  );
}
