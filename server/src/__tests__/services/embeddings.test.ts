import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveFamily, getDefaultFamily, runEmbeddings } from '../../services/embeddings.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`) {
  const { encrypted, iv, authTag } = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}

function addCustomKey(baseUrl: string, raw = 'custom-test-key'): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  return Number(row.lastInsertRowid);
}

function okEmbeddingResponse(dims: number, count = 1) {
  return new Response(JSON.stringify({
    data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: Array(dims).fill(0.1) })),
    usage: { prompt_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Typed fetch mock so .mock.calls is properly indexed without `as any` on
// every call site. The cast on assignment to globalThis.fetch is unavoidable
// because globalThis.fetch in lib.dom is typed loosely; this is the same
// pattern the test suite uses for globalThis.fetch overrides throughout.
function mockFetch(impl: typeof fetch): MockedFunction<typeof fetch> {
  const m = vi.fn(impl) as MockedFunction<typeof fetch>;
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

describe('embeddings service', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('migration seed', () => {
    it('seeds the embedding catalog with families and a default', () => {
      const rows = getDb().prepare('SELECT DISTINCT family FROM embedding_models').all() as { family: string }[];
      const families = rows.map(r => r.family);
      expect(families).toContain('gemini-embedding-001');
      expect(families).toContain('llama-nemotron-embed-vl-1b-v2');
      expect(families).toContain('bge-m3');
      expect(getDefaultFamily()).toBe('gemini-embedding-001');
    });

    it('cohere is seeded disabled (its quota is shared with chat)', () => {
      const row = getDb().prepare("SELECT enabled FROM embedding_models WHERE platform = 'cohere'").get() as { enabled: number };
      expect(row.enabled).toBe(0);
    });

    it('multi-provider families share one dimension', () => {
      const dims = getDb().prepare(
        "SELECT DISTINCT dimensions FROM embedding_models WHERE family = 'llama-nemotron-embed-vl-1b-v2'",
      ).all();
      expect(dims).toHaveLength(1);
    });

    it('adds key_id for custom embedding endpoint binding', () => {
      const cols = (getDb().prepare('PRAGMA table_info(embedding_models)').all() as { name: string }[]).map(c => c.name);
      expect(cols).toContain('key_id');
    });
  });

  describe('resolveFamily', () => {
    it("maps 'auto', empty and undefined to the default family", () => {
      expect(resolveFamily('auto')).toBe('gemini-embedding-001');
      expect(resolveFamily('')).toBe('gemini-embedding-001');
      expect(resolveFamily(undefined)).toBe('gemini-embedding-001');
    });

    it('accepts a family name directly', () => {
      expect(resolveFamily('bge-m3')).toBe('bge-m3');
    });

    it('maps a provider-specific model id to its family', () => {
      expect(resolveFamily('@cf/baai/bge-m3')).toBe('bge-m3');
      expect(resolveFamily('nvidia/llama-nemotron-embed-vl-1b-v2')).toBe('llama-nemotron-embed-vl-1b-v2');
    });

    it('returns null for unknown models', () => {
      expect(resolveFamily('text-embedding-ada-002')).toBeNull();
    });
  });

  describe('multimodal + siliconflow-cn', () => {
    function addSfCnRow(family = 'Qwen/Qwen3-VL-Embedding-8B') {
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
        VALUES (?, 'siliconflow-cn', 'Qwen/Qwen3-VL-Embedding-8B', 'Qwen3-VL Embedding 8B', 4096, 1, 1, 'test')
      `).run(family);
    }

    it('serves siliconflow-cn rows via the SF adapter', async () => {
      addKey('siliconflow-cn');
      addSfCnRow();
      const fetchMock = mockFetch(async () => okEmbeddingResponse(4096));

      const result = await runEmbeddings('Qwen/Qwen3-VL-Embedding-8B', ['细胞的基本结构']);
      expect(result.platform).toBe('siliconflow-cn');
      expect(result.dimensions).toBe(4096);
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.siliconflow.cn/v1/embeddings');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.input).toEqual(['细胞的基本结构']);
    });

    it('passes multimodal input items through verbatim', async () => {
      addKey('siliconflow-cn');
      addSfCnRow();
      const fetchMock = mockFetch(async () => okEmbeddingResponse(4096));

      const imagePart = { image: 'data:image/png;base64,iVBORw0KGgo=' };
      await runEmbeddings('Qwen/Qwen3-VL-Embedding-8B', [imagePart]);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.input).toEqual([imagePart]);
    });

    it('routes multimodal requests past text-only providers in the same family', async () => {
      addKey('google');
      addKey('siliconflow-cn');
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
        VALUES ('mm-test', 'google', 'gemini-embedding-001-mmdup', 'Gemini', 4096, 1, 1, 'test')
      `).run();
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
        VALUES ('mm-test', 'siliconflow-cn', 'Qwen/Qwen3-VL-Embedding-8B', 'Qwen3-VL', 4096, 2, 1, 'test')
      `).run();
      const fetchMock = mockFetch(async () => okEmbeddingResponse(4096));

      const result = await runEmbeddings('mm-test', [{ image: 'data:image/png;base64,iVBORw0KGgo=' }]);
      expect(result.platform).toBe('siliconflow-cn');
      expect(String(fetchMock.mock.calls[0][0])).toContain('siliconflow.cn');
      expect(String(fetchMock.mock.calls[0][0])).not.toContain('googleapis.com');
    });

    it('custom endpoint gets encoding_format float in the request body', async () => {
      const keyId = addCustomKey('https://api-inference.modelscope.cn/v1');
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
        VALUES ('ms-only-family', 'custom', 'Qwen/Qwen3-VL-Embedding-8B', 'MS', 4096, 1, 1, 'test', ?)
      `).run(keyId);
      const fetchMock = mockFetch(async () => okEmbeddingResponse(4096));

      await runEmbeddings('ms-only-family', ['细胞']);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.encoding_format).toBe('float');
    });

    it('rejects multimodal input when the family chain is text-only', async () => {
      addKey('google');
      await expect(
        runEmbeddings('gemini-embedding-001', [{ image: 'data:image/png;base64,iVBORw0KGgo=' }]),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('routes gemini-embedding-2 image input to the native embedContent API', async () => {
      addKey('google');
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
        VALUES ('gemini-embedding-2', 'google', 'gemini-embedding-2', 'Gemini Embedding 2', 3072, 1, 1, 'test')
      `).run();
      const fetchMock = mockFetch(async () => new Response(JSON.stringify({
        embedding: { values: Array(3072).fill(0.05) },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await runEmbeddings('gemini-embedding-2', [
        { image: 'data:image/png;base64,iVBORw0KGgo=' },
      ]);
      expect(result.platform).toBe('google');
      expect(result.dimensions).toBe(3072);
      expect(result.vectors[0]).toHaveLength(3072);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBeTruthy();
      const body = JSON.parse(init.body as string);
      expect(body.content.parts).toEqual([
        { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ]);
    });

    it('keeps text batches on the OpenAI-compat endpoint for gemini-embedding-2', async () => {
      addKey('google');
      getDb().prepare(`
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
        VALUES ('gemini-embedding-2', 'google', 'gemini-embedding-2', 'Gemini Embedding 2', 3072, 1, 1, 'test')
      `).run();
      const fetchMock = mockFetch(async () => okEmbeddingResponse(3072, 2));

      await runEmbeddings('gemini-embedding-2', ['细胞结构', '光合作用']);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('/v1beta/openai/embeddings');
    });

    it('estimates tokens for non-text parts instead of crashing', async () => {
      addKey('siliconflow-cn');
      addSfCnRow();
      mockFetch(async () => new Response(JSON.stringify({
        data: [{ index: 0, embedding: Array(4096).fill(0.1) }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await runEmbeddings('Qwen/Qwen3-VL-Embedding-8B', [
        { image: 'data:image/png;base64,iVBORw0KGgo=' },
      ]);
      expect(result.inputTokens).toBeGreaterThan(0);
    });
  });

  describe('runEmbeddings', () => {
    it('rejects unknown models with a 400', async () => {
      await expect(runEmbeddings('no-such-model', ['hi'])).rejects.toMatchObject({ status: 400 });
    });

    it('embeds via the first provider in the family chain', async () => {
      addKey('nvidia');
      addKey('openrouter');
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2048));

      const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
      expect(result.platform).toBe('nvidia');
      expect(result.dimensions).toBe(2048);
      expect(result.vectors).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('integrate.api.nvidia.com');
    });

    it('fails over WITHIN the family when the first provider errors', async () => {
      addKey('nvidia');
      addKey('openrouter');
      const fetchMock = mockFetch(async () => new Response('rate limited', { status: 429 }));
      fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
      fetchMock.mockResolvedValueOnce(okEmbeddingResponse(2048));

      const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
      expect(result.platform).toBe('openrouter');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain('openrouter.ai');
    });

    it('skips providers without a usable key instead of failing', async () => {
      addKey('openrouter'); // no nvidia key
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2048));

      const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
      expect(result.platform).toBe('openrouter');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws 429 when every provider is rate-limited', async () => {
      addKey('nvidia');
      addKey('openrouter');
      mockFetch(async () => new Response('slow down', { status: 429 }));

      await expect(runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'])).rejects.toMatchObject({ status: 429 });
    });

    it('throws 503 when the family has no enabled providers', async () => {
      getDb().prepare("UPDATE embedding_models SET enabled = 0 WHERE family = 'bge-m3'").run();
      await expect(runEmbeddings('bge-m3', ['hello'])).rejects.toMatchObject({ status: 503 });
    });

    it('splits cloudflare account_id:token keys', async () => {
      addKey('cloudflare', 'acct-123:cf-token-xyz');
      const fetchMock = mockFetch(async () => okEmbeddingResponse(1024));

      const result = await runEmbeddings('embeddinggemma-300m', ['hello']);
      expect(result.platform).toBe('cloudflare');
      expect(String(fetchMock.mock.calls[0][0])).toContain('/accounts/acct-123/ai/v1/embeddings');
      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer cf-token-xyz');
    });

    it('normalizes hugging face feature-extraction output', async () => {
      // bge-m3: cloudflare first (no key) → falls through to huggingface
      addKey('huggingface');
      const fetchMock = mockFetch(async () => new Response(JSON.stringify([[0.1, 0.2, 0.3]]), { status: 200 }));

      const result = await runEmbeddings('bge-m3', ['hello']);
      expect(result.platform).toBe('huggingface');
      expect(result.dimensions).toBe(3);
      expect(String(fetchMock.mock.calls[0][0])).toContain('feature-extraction');
    });

    it('routes SEA-LION catalog embeddings through its OpenAI-compatible endpoint', async () => {
      getDb().prepare(`
        INSERT INTO embedding_models
          (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label)
        VALUES
          ('sea-lion-e5-embedding-600m', 'sealion', 'aisingapore/SEA-LION-E5-Embedding-600M',
           'SEA-LION E5 Embedding 600M', 1024, 8192, 1, 1, 'free · 10 rpm')
      `).run();
      addKey('sealion');
      const fetchMock = mockFetch(async () => okEmbeddingResponse(1024));

      const result = await runEmbeddings('sea-lion-e5-embedding-600m', ['hello']);

      expect(result.platform).toBe('sealion');
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.sea-lion.ai/v1/embeddings');
    });

    it('rejects malformed upstream payloads and fails over', async () => {
      addKey('nvidia');
      addKey('openrouter');
      const fetchMock = mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 })); // wrong count
      fetchMock.mockResolvedValueOnce(okEmbeddingResponse(2048));

      const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
      expect(result.platform).toBe('openrouter');
    });

    it("logs requests tagged request_type='embedding' so chat budgets ignore them", async () => {
      addKey('nvidia');
      addKey('openrouter');
      const fetchMock = mockFetch(async () => new Response('boom', { status: 500 }));
      fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
      fetchMock.mockResolvedValueOnce(okEmbeddingResponse(2048));

      await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
      const rows = getDb().prepare(
        "SELECT platform, status, request_type FROM requests ORDER BY id",
      ).all() as { platform: string; status: string; request_type: string }[];
      expect(rows).toEqual([
        { platform: 'nvidia', status: 'error', request_type: 'embedding' },
        { platform: 'openrouter', status: 'success', request_type: 'embedding' },
      ]);

      // and the chat-scoped monthly usage query sees none of it
      const chatUsed = getDb().prepare(`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
        FROM requests
        WHERE created_at >= datetime('now', 'start of month') AND request_type = 'chat'
      `).get() as { used: number };
      expect(chatUsed.used).toBe(0);
    });

    it('routes custom embeddings through the model-bound endpoint key', async () => {
      const keyId = addCustomKey('http://127.0.0.1:8181/v1', 'custom-embed-key');
      getDb().prepare(`
        INSERT INTO embedding_models
          (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
        VALUES ('local-embed', 'custom', 'local-embed-v1', 'Local Embed', 3, NULL, 1, 1, '', ?)
      `).run(keyId);
      const fetchMock = mockFetch(async () => okEmbeddingResponse(3));

      const result = await runEmbeddings('local-embed', ['hello']);

      expect(result.platform).toBe('custom');
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8181/v1/embeddings');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer custom-embed-key');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('local-embed-v1');
      const log = getDb().prepare("SELECT key_id FROM requests WHERE request_type = 'embedding' ORDER BY id DESC LIMIT 1").get() as { key_id: number };
      expect(log.key_id).toBe(keyId);
    });

    describe('dimensions parameter (MRL truncation)', () => {
      it('forwards dimensions to NVIDIA NeMo NIM in the request body', async () => {
        addKey('nvidia');
        const fetchMock = mockFetch(async () => okEmbeddingResponse(1536));

        await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'], 1536);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        expect(body.dimensions).toBe(1536);
        // The provider-prefixed model id (nvidia/<id>) is what reaches the upstream;
        // the bare id is used internally for family resolution only.
        expect(body.model).toBe('nvidia/llama-nemotron-embed-vl-1b-v2');
        // input_type is still set on nvidia (existing behavior preserved)
        expect(body.input_type).toBe('query');
      });

      it('omits dimensions from the upstream body when not requested', async () => {
        addKey('nvidia');
        const fetchMock = mockFetch(async () => okEmbeddingResponse(2048));

        await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);

        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        expect(body).not.toHaveProperty('dimensions');
      });

      it('returns the truncated dimension reported by the upstream response', async () => {
        addKey('nvidia');
        // Mock responds with 1536-dim vector even though model is native 2048.
        mockFetch(async () => okEmbeddingResponse(1536));

        const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'], 1536);
        expect(result.dimensions).toBe(1536);
        expect(result.vectors[0]).toHaveLength(1536);
      });

      it('forwards dimensions to the google provider', async () => {
        // Use a family served by google. gemini-embedding-001 has google in its chain.
        addKey('google');
        const fetchMock = mockFetch(async () => okEmbeddingResponse(768));

        await runEmbeddings('gemini-embedding-001', ['hello'], 768);

        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        expect(body.dimensions).toBe(768);
        expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
      });

      it('forwards dimensions to the github provider', async () => {
        addKey('github');
        const fetchMock = mockFetch(async () => okEmbeddingResponse(512));

        await runEmbeddings('text-embedding-3-small', ['hello'], 512);

        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        expect(body.dimensions).toBe(512);
        expect(String(fetchMock.mock.calls[0][0])).toContain('models.github.ai');
      });

      it('forwards dimensions to the openrouter provider', async () => {
        addKey('openrouter');
        const fetchMock = mockFetch(async () => okEmbeddingResponse(1024));

        await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'], 1024);

        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        expect(body.dimensions).toBe(1024);
        expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
      });

      it('preserves byte-identical upstream bodies when dimensions is undefined', async () => {
        // Snapshot the request body that runEmbeddings sends today, then verify
        // that adding the dimensions parameter does not change ANY other field.
        addKey('nvidia');
        const beforeMock = mockFetch(async () => okEmbeddingResponse(2048));
        await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello']);
        const beforeBody = JSON.parse(String((beforeMock.mock.calls[0][1] as RequestInit).body));

        addKey('nvidia'); // re-seed; previous run consumed nothing
        const afterMock = mockFetch(async () => okEmbeddingResponse(2048));
        await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'], undefined);
        const afterBody = JSON.parse(String((afterMock.mock.calls[0][1] as RequestInit).body));

        expect(afterBody).toEqual(beforeBody);
      });

      it('passes dimensions through the family failover chain', async () => {
        // nvidia is the primary for llama-nemotron-embed-vl-1b-v2; if it 429s,
        // openrouter takes over. Both should see the dimensions parameter.
        addKey('nvidia');
        addKey('openrouter');
        const fetchMock = mockFetch(async () => new Response('rate limited', { status: 429 }));
        fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
        fetchMock.mockResolvedValueOnce(okEmbeddingResponse(1024));

        const result = await runEmbeddings('llama-nemotron-embed-vl-1b-v2', ['hello'], 1024);
        expect(result.platform).toBe('openrouter');
        expect(result.dimensions).toBe(1024);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Both attempts forwarded dimensions
        const body1 = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
        const body2 = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
        expect(body1.dimensions).toBe(1024);
        expect(body2.dimensions).toBe(1024);
      });
    });
  });
});
