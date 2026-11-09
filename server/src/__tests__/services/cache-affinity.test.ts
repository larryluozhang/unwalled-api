import { beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_WORTH_TOKENS,
  clearCacheAffinity,
  cacheAffinitySize,
  preferCacheAffinity,
  recordCacheAffinitySuccess,
} from '../../services/cache-affinity.js';
import { extractCacheUsage } from '../../lib/usage-cache.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hello' },
];
const context = { sessionKey: 'session-1', profileScope: 'auto:test', clientIdentity: 'client-1', mode: 'cache' as const };

beforeEach(() => clearCacheAffinity());

describe('cache usage normalization', () => {
  it('reads OpenAI, Anthropic and Gemini fields and preserves absence', () => {
    expect(extractCacheUsage({ usage: { prompt_tokens_details: { cached_tokens: 2048 } } }).read).toBe(2048);
    expect(extractCacheUsage({ usage: { cache_read_input_tokens: 2048, cache_creation_input_tokens: 512 } })).toEqual({ read: 2048, write: 512 });
    expect(extractCacheUsage({ usageMetadata: { cachedContentTokenCount: 2048 } }).read).toBe(2048);
    expect(extractCacheUsage({ usage: { prompt_tokens: 100 } })).toEqual({ read: null, write: null });
  });
});

describe('cache affinity', () => {
  it('is opt-in and requires a real worthwhile cache read', () => {
    recordCacheAffinitySuccess(context, messages, [], { modelDbId: 1, keyId: 2, usage: { cache_read_input_tokens: CACHE_WORTH_TOKENS - 1 } });
    expect(cacheAffinitySize()).toBe(0);
    recordCacheAffinitySuccess({ ...context, mode: 'legacy' }, messages, [], { modelDbId: 1, keyId: 2, usage: { cache_read_input_tokens: CACHE_WORTH_TOKENS } });
    expect(cacheAffinitySize()).toBe(0);
  });

  it('soft-prefers the previous key for the same prefix and tools', () => {
    recordCacheAffinitySuccess(context, messages, [], { modelDbId: 1, keyId: 2, usage: { cache_read_input_tokens: CACHE_WORTH_TOKENS } });
    const candidates = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(preferCacheAffinity(context, 1, '', candidates, messages, []).map(k => k.id)).toEqual([2, 1, 3]);
  });

  it('does not cross model, endpoint, client or changed tools', () => {
    recordCacheAffinitySuccess(context, messages, [], { modelDbId: 1, keyId: 2, usage: { cache_read_input_tokens: CACHE_WORTH_TOKENS } });
    expect(preferCacheAffinity(context, 2, '', [{ id: 1 }, { id: 2 }], messages, []).map(k => k.id)).toEqual([1, 2]);
    expect(preferCacheAffinity(context, 1, 'other', [{ id: 1 }, { id: 2 }], messages, []).map(k => k.id)).toEqual([1, 2]);
    expect(preferCacheAffinity({ ...context, clientIdentity: 'other' }, 1, '', [{ id: 1 }, { id: 2 }], messages, []).map(k => k.id)).toEqual([1, 2]);
    expect(preferCacheAffinity(context, 1, '', [{ id: 1 }, { id: 2 }], messages, [{ name: 'changed' }]).map(k => k.id)).toEqual([1, 2]);
  });

  it('expires and never invents a key outside the eligible candidate list', () => {
    recordCacheAffinitySuccess(context, messages, [], { modelDbId: 1, keyId: 99, usage: { cache_read_input_tokens: CACHE_WORTH_TOKENS }, now: 1000, ttlMs: 10 });
    expect(preferCacheAffinity(context, 1, '', [{ id: 1 }, { id: 99 }], messages, [], 1011).map(k => k.id)).toEqual([1, 99]);
    expect(preferCacheAffinity(context, 1, '', [{ id: 1 }, { id: 2 }], messages, [], 1001).map(k => k.id)).toEqual([1, 2]);
  });
});
