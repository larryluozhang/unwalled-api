// Embeddings routing. Unlike chat, embeddings can NOT fail over across models:
// vectors from different models live in incompatible spaces, and silently
// switching models would corrupt any vector store built on top of us. So the
// routing unit is a "family" (one model identity + dimension) and failover only
// walks the providers serving that same family.
//
// `model: "auto"` (or empty) routes to the configured default family — so auto
// always works: with one provider it just uses that one, with several it gets
// cross-provider redundancy for free.
import { getDb, getSetting } from '../db/index.js';
import { getClientContext } from '../lib/client-context.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';
import { customEndpointKeyIds } from './custom-endpoint.js';
import type { Db } from '../db/types.js';

export interface EmbeddingModelRow {
  id: number;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  dimensions: number;
  max_input_tokens: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
}

/** One embedding input item: plain text, a provider-specific content part
 * (e.g. `{"image": "data:image/png;base64,…"}` DashScope/SiliconFlow style),
 * or an array of content parts forming one multimodal document. The gateway
 * is a passthrough: parts flow to the provider verbatim, it never interprets
 * them. */
export type EmbeddingInputItem =
  | string
  | Record<string, unknown>
  | Array<Record<string, unknown>>;

/** Model-id markers advertising image/vision embedding support. A multimodal
 * request may only be served by rows whose model matches — silently routing
 * image input to a text-only model would either 400 upstream or, worse,
 * produce a text-only vector for an image document. */
const MULTIMODAL_MODEL_MARKERS = [
  'qwen3-vl-embedding',
  'vl-embedding',
  'vision-embedding',
  'image-embedding',
  'multimodal-embedding',
  'embed-vl',
  // Google's first natively multimodal embedding model (5 modalities, 2026-03
  // preview): the name carries no VL marker, so list it explicitly.
  'gemini-embedding-2',
];

export function isMultimodalEmbeddingModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.toLowerCase().replace(/_/g, '-');
  return MULTIMODAL_MODEL_MARKERS.some(m => normalized.includes(m));
}

export interface EmbeddingsResult {
  family: string;
  platform: string;
  modelId: string;
  dimensions: number;
  vectors: number[][];
  inputTokens: number;
}

export class EmbeddingsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function listEmbeddingModels(): EmbeddingModelRow[] {
  return getDb().prepare(
    'SELECT * FROM embedding_models ORDER BY family, priority',
  ).all() as EmbeddingModelRow[];
}

export function getDefaultFamily(): string {
  return getSetting('embeddings_default_family') ?? 'gemini-embedding-001';
}

/** Map the request's `model` to a family: 'auto'/empty → default; a family
 * name → itself; a provider-specific model id → its family. */
export function resolveFamily(model: string | undefined): string | null {
  if (!model || model === 'auto') return getDefaultFamily();
  const rows = listEmbeddingModels();
  if (rows.some(r => r.family === model)) return model;
  const byModelId = rows.find(r => r.model_id === model);
  return byModelId?.family ?? null;
}

interface ProviderCredential {
  id: number;
  key: string;
  baseUrl: string | null;
}

function getProviderCredential(row: EmbeddingModelRow): ProviderCredential | null {
  if (row.key_id != null) {
    const keyRow = getDb().prepare(
      "SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1",
    ).get(row.key_id) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
    if (!keyRow) return null;
    try {
      return {
        id: keyRow.id,
        key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
      };
    } catch {
      return null;
    }
  }
  if (row.platform === 'custom') return null;

  const keyRow = getDb().prepare(
    "SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY RANDOM() LIMIT 1",
  ).get(row.platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
  if (!keyRow) return null;
  try {
    return {
      id: keyRow.id,
      key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
      baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
    };
  } catch {
    return null;
  }
}

// Rough token estimate when the provider doesn't report usage (~4 chars/token
// for text; a flat per-part charge for image/binary parts whose token cost we
// cannot infer from the payload).
function estimateTokens(inputs: EmbeddingInputItem[]): number {
  let chars = 0;
  let nonTextParts = 0;
  const walk = (item: EmbeddingInputItem | Record<string, unknown>) => {
    if (typeof item === 'string') {
      chars += item.length;
      return;
    }
    if (Array.isArray(item)) {
      for (const part of item) walk(part);
      return;
    }
    nonTextParts += 1;
    for (const v of Object.values(item)) {
      if (typeof v === 'string' && v.length < 2000 && !v.startsWith('data:')) chars += v.length;
    }
  };
  for (const item of inputs) walk(item);
  return Math.ceil(chars / 4) + nonTextParts * 512;
}

// Serverless embedding backends (SiliconFlow Qwen3-VL-Embedding-8B) cold-start
// at 30-60s after idle, and legal batches (32 images) are slow by nature —
// 30s aborts killed whole reindex runs at the probe stage.
const FETCH_TIMEOUT_MS = 120_000;

/** Provider adapters that can safely receive catalog-managed embedding rows. */
export const EMBEDDING_PLATFORMS = new Set([
  'google',
  'nvidia',
  'openrouter',
  'github',
  'cloudflare',
  'huggingface',
  'cohere',
  'sealion',
]);

interface ProviderCallResult {
  vectors: number[][];
  inputTokens: number | null; // provider-reported, when available
}

async function openAiStyleEmbed(
  url: string,
  platform: string,
  key: string,
  modelId: string,
  inputs: EmbeddingInputItem[],
  extra: Record<string, unknown> = {},
  dimensions?: number,
): Promise<ProviderCallResult> {
  const body: Record<string, unknown> = { model: modelId, input: inputs, ...extra };
  // Some providers (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3) support
  // Matryoshka Representation Learning (MRL) — a smaller output_dim is valid and
  // truncates the vector rather than failing. Others (HuggingFace feature-extraction,
  // Cloudflare BGE) ignore unknown fields silently. We only forward the param when
  // the caller asked for an explicit override, so providers that don't accept it
  // see a request body identical to today.
  if (dimensions !== undefined) body.dimensions = dimensions;
  const r = await proxyFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, platform, 'embedding', FETCH_TIMEOUT_MS);
  if (!r.ok) {
    throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
  }
  const j = (await r.json()) as {
    data?: { index?: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    vectors: data.map(d => d.embedding),
    inputTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? null,
  };
}

/** Google native embedContent: the OpenAI-compat endpoint
 * (/v1beta/openai/embeddings) is TEXT-ONLY — gemini-embedding-2's multimodal
 * inputs (image/audio/video/pdf) only exist on the native API, as
 * content.parts[].inline_data. One call per input item (the native batch
 * variant takes the same parts anyway, and multimodal payloads arrive singly
 * from llamaindex image nodes). Accepted media: PNG/JPEG only (WebP 400s
 * upstream, a documented gemini-embedding-2 limitation vs generateContent). */
function toGeminiParts(item: EmbeddingInputItem): Record<string, unknown>[] {
  const toPart = (p: unknown): Record<string, unknown> => {
    if (typeof p === 'string') return { text: p };
    const obj = p as Record<string, unknown>;
    // DashScope/SiliconFlow style: {"image": "data:image/png;base64,…"}
    // OpenAI vision style: {"type": "image_url", "image_url": {"url": "data:…"}}
    const uri =
      (typeof obj.image === 'string' ? obj.image : null) ??
      (typeof obj.image_url === 'object' && obj.image_url !== null
        ? (obj.image_url as Record<string, unknown>).url
        : null) ??
      (typeof obj.image_url === 'string' ? obj.image_url : null);
    if (typeof uri === 'string' && uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      const mime = uri.slice(5, uri.indexOf(';'));
      return { inline_data: { mime_type: mime, data: uri.slice(comma + 1) } };
    }
    if (typeof obj.text === 'string') return { text: obj.text };
    throw new EmbeddingsError('unsupported multimodal part shape for google native embedding', 400);
  };
  return Array.isArray(item) ? item.map(toPart) : [toPart(item)];
}

async function googleNativeEmbed(
  key: string,
  modelId: string,
  inputs: EmbeddingInputItem[],
  dimensions?: number,
): Promise<ProviderCallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:embedContent`;
  const vectors: number[][] = [];
  for (const item of inputs) {
    const body: Record<string, unknown> = { content: { parts: toGeminiParts(item) } };
    if (dimensions !== undefined) body.outputDimensionality = dimensions;
    const r = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }, 'google', 'embedding', FETCH_TIMEOUT_MS);
    if (!r.ok) {
      throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
    }
    const j = (await r.json()) as { embedding?: { values?: number[] } };
    if (!Array.isArray(j.embedding?.values)) {
      throw new EmbeddingsError('upstream returned malformed embeddings', 502);
    }
    vectors.push(j.embedding.values);
  }
  return { vectors, inputTokens: null };
}

export async function probeEmbeddingDimensions(baseUrl: string, key: string, modelId: string): Promise<number> {
  const out = await openAiStyleEmbed(`${baseUrl.trim().replace(/\/+$/, '')}/embeddings`, 'custom', key, modelId, ['dimension probe']);
  const vector = out.vectors[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingsError('upstream returned malformed embeddings', 502);
  }
  return vector.length;
}

export interface CustomEmbeddingRegistration {
  keyId: number;
  modelId: string;
  displayName: string | null;
  family: string;
  dimensions: number;
  maxInputTokens: number | null;
  quotaLabel: string;
}

/**
 * Upsert one custom embedding model bound to an endpoint credential — the
 * shared write path behind POST /api/embeddings/custom and the bulk key
 * importer (#382). Throws EmbeddingsError(400) when the family already exists
 * at a different dimension: vectors from mismatched spaces must never mix, so
 * the caller has to pick a new family name instead.
 */
export function registerCustomEmbeddingModel(db: Db, reg: CustomEmbeddingRegistration): { modelDbId: number; created: boolean } {
  const sibling = db.prepare(`
    SELECT dimensions
      FROM embedding_models
     WHERE family = ?
       AND NOT (platform = 'custom' AND model_id = ?)
     LIMIT 1
  `).get(reg.family, reg.modelId) as { dimensions: number } | undefined;
  if (sibling && sibling.dimensions !== reg.dimensions) {
    throw new EmbeddingsError(
      `Embedding family '${reg.family}' is ${sibling.dimensions} dimensions, but '${reg.modelId}' returned ${reg.dimensions}. Use a new family name.`,
      400,
    );
  }

  const endpointKeyIds = customEndpointKeyIds(db, reg.keyId);
  const existingModel = db.prepare(`
    SELECT id, priority, key_id
      FROM embedding_models
     WHERE platform = 'custom' AND model_id = ?
     LIMIT 1
  `).get(reg.modelId) as { id: number; priority: number; key_id: number | null } | undefined;
  // A model already on this endpoint keeps the key it has; only a move to a
  // different endpoint re-binds it.
  const bindKeyId = existingModel?.key_id != null && endpointKeyIds.has(existingModel.key_id)
    ? existingModel.key_id
    : reg.keyId;
  const priority = existingModel?.priority ?? (
    (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM embedding_models WHERE family = ?')
      .get(reg.family) as { maxPriority: number }).maxPriority + 1
  );

  // `display_name` is optional: a new model takes its id, and a model already
  // on record keeps the name it has instead of being reset by a submit that
  // simply left the field blank (#704).
  if (existingModel) {
    db.prepare(`
      UPDATE embedding_models
         SET family = ?,
             display_name = COALESCE(?, display_name),
             dimensions = ?,
             max_input_tokens = ?,
             priority = ?,
             enabled = 1,
             quota_label = ?,
             key_id = ?
       WHERE id = ?
    `).run(reg.family, reg.displayName, reg.dimensions, reg.maxInputTokens, priority, reg.quotaLabel, bindKeyId, existingModel.id);
    return { modelDbId: existingModel.id, created: false };
  }

  const model = db.prepare(`
    INSERT INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
    VALUES (?, 'custom', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(reg.family, reg.modelId, reg.displayName ?? reg.modelId, reg.dimensions, reg.maxInputTokens, priority, reg.quotaLabel, bindKeyId);
  return { modelDbId: Number(model.lastInsertRowid), created: true };
}

async function callProvider(row: EmbeddingModelRow, credential: ProviderCredential, inputs: EmbeddingInputItem[], dimensions?: number): Promise<ProviderCallResult> {
  const { key } = credential;
  switch (row.platform) {
    case 'custom':
      if (!credential.baseUrl) throw new EmbeddingsError('custom embedding provider is missing base_url', 500);
      // ModelScope's free inference API hard-requires encoding_format
      // ('float'|'base64'), 400ing when absent (HKUDS/DeepTutor#934 hit the same
      // wall). It's OpenAI-spec'd and every compliant endpoint tolerates it —
      // but SiliconFlow 400s on it, which is why this stays scoped to custom.
      return openAiStyleEmbed(`${credential.baseUrl}/embeddings`, row.platform, key, row.model_id, inputs, { encoding_format: 'float' }, dimensions);
    case 'google': {
      // Multimodal inputs must go to the native embedContent API — the
      // OpenAI-compat endpoint 400s on anything but plain strings.
      const hasMedia = inputs.some(i => typeof i !== 'string');
      if (hasMedia) return googleNativeEmbed(key, row.model_id, inputs, dimensions);
      return openAiStyleEmbed('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    }
    case 'siliconflow-cn':
      return openAiStyleEmbed('https://api.siliconflow.cn/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'siliconflow':
      return openAiStyleEmbed('https://api.siliconflow.com/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'modelscope':
      // ModelScope's free inference API hard-requires encoding_format
      // ('float'|'base64'), 400ing when absent (same wall as the custom
      // adapter, HKUDS/DeepTutor#934). First-class case (not custom) so the
      // existing platform='modelscope' key (base_url hardcoded in the LLM
      // provider) can back an embedding family row as a same-model fallback.
      // Deliberately NOT added to EMBEDDING_PLATFORMS: catalog-sync GC would
      // delete manually-registered rows the upstream catalog doesn't list.
      return openAiStyleEmbed('https://api-inference.modelscope.cn/v1/embeddings', row.platform, key, row.model_id, inputs, { encoding_format: 'float' }, dimensions);
    case 'nvidia':
      // NeMo Retriever NIMs require input_type; 'query' is the symmetric-safe
      // choice for a gateway that can't know whether this is index or query time.
      // MRL models (e.g. llama-nemotron-embed-1b-v2) accept dimensions and truncate.
      return openAiStyleEmbed('https://integrate.api.nvidia.com/v1/embeddings', row.platform, key, row.model_id, inputs, { input_type: 'query' }, dimensions);
    case 'openrouter':
      return openAiStyleEmbed('https://openrouter.ai/api/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'github':
      return openAiStyleEmbed('https://models.github.ai/inference/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'sealion':
      return openAiStyleEmbed('https://api.sea-lion.ai/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'cloudflare': {
      // Key is stored as "account_id:token".
      const sep = key.indexOf(':');
      if (sep === -1) throw new EmbeddingsError('cloudflare key is not in account_id:token form', 500);
      const accountId = key.slice(0, sep);
      const token = key.slice(sep + 1);
      return openAiStyleEmbed(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`,
        row.platform, token, row.model_id, inputs, {},
      );
    }
    case 'huggingface': {
      // HF serves embeddings as the feature-extraction task, not /v1/embeddings.
      const r = await proxyFetch(
        `https://router.huggingface.co/hf-inference/models/${row.model_id}/pipeline/feature-extraction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ inputs }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
        row.platform, 'embedding', FETCH_TIMEOUT_MS,
      );
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = await r.json() as number[][] | number[];
      const vectors = Array.isArray(j[0]) ? (j as number[][]) : [j as number[]];
      return { vectors, inputTokens: null };
    }
    case 'cohere': {
      const r = await proxyFetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model_id,
          texts: inputs,
          input_type: 'search_document',
          embedding_types: ['float'],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }, row.platform, 'embedding', FETCH_TIMEOUT_MS);
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = (await r.json()) as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
      return { vectors: j.embeddings?.float ?? [], inputTokens: j.meta?.billed_units?.input_tokens ?? null };
    }
    default:
      throw new EmbeddingsError(`no embeddings adapter for platform '${row.platform}'`, 500);
  }
}

function logEmbeddingRequest(
  row: EmbeddingModelRow,
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
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'embedding', ?, ?, ?)
    `).run(row.platform, row.model_id, keyId, status, inputTokens, latencyMs, error, client.ip, client.userAgent, client.agent);
  } catch (e) {
    console.error('Failed to log embedding request:', e);
  }
}

/** Embed `inputs` via the family's provider chain, failing over within the
 * family on any provider error. Throws EmbeddingsError when the chain is dry.
 *
 * `dimensions` (optional): client-supplied output-dimension override forwarded to
 * providers that support MRL truncation (NVIDIA NeMo NIM, Google Gemini Embedding,
 * OpenAI text-embedding-3-*). Providers that ignore the field see an identical
 * request body. The override is independent of the model's native dimension — the
 * family registry still pins the canonical dimension, this just lets callers ask
 * for a smaller vector at the cost of some accuracy. */
export async function runEmbeddings(model: string | undefined, inputs: EmbeddingInputItem[], dimensions?: number): Promise<EmbeddingsResult> {
  const family = resolveFamily(model);
  if (!family) {
    throw new EmbeddingsError(
      `Unknown embedding model '${model}'. Use 'auto', a family name, or a provider model id.`, 400,
    );
  }

  const chain = (getDb().prepare(
    'SELECT * FROM embedding_models WHERE family = ? AND enabled = 1 ORDER BY priority',
  ).all(family) as EmbeddingModelRow[]);
  if (chain.length === 0) {
    throw new EmbeddingsError(`No enabled providers for embedding family '${family}'.`, 503);
  }

  const wantsMultimodal = inputs.some(i => typeof i !== 'string');

  let lastError: EmbeddingsError | null = null;
  for (const row of chain) {
    if (wantsMultimodal && !isMultimodalEmbeddingModel(row.model_id)) {
      lastError = new EmbeddingsError(
        `provider model '${row.model_id}' is text-only and cannot serve a multimodal input`, 400,
      );
      continue;
    }
    const credential = getProviderCredential(row);
    if (!credential) continue; // no usable key for this provider — try the next one
    const started = Date.now();
    try {
      const out = await callProvider(row, credential, inputs, dimensions);
      if (out.vectors.length !== inputs.length || out.vectors.some(v => !Array.isArray(v) || v.length === 0)) {
        throw new EmbeddingsError('upstream returned malformed embeddings', 502);
      }
      const tokens = out.inputTokens ?? estimateTokens(inputs);
      logEmbeddingRequest(row, credential.id, 'success', tokens, Date.now() - started, null);
      return {
        family,
        platform: row.platform,
        modelId: row.model_id,
        dimensions: out.vectors[0].length,
        vectors: out.vectors,
        inputTokens: tokens,
      };
    } catch (err: any) {
      const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String(err?.message ?? err), 502);
      logEmbeddingRequest(row, credential.id, 'error', 0, Date.now() - started, e.message.slice(0, 300));
      lastError = e;
      // fall through to the next provider in the family
    }
  }

  throw new EmbeddingsError(
    `All providers for embedding family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && (lastError.status === 429 || lastError.status === 400) ? lastError.status : 502,
  );
}
