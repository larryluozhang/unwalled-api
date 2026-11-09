import type { TokenUsage } from '@freellmapi/shared/types.js';

export interface CacheUsage {
  read: number | null;
  write: number | null;
}

const absent: CacheUsage = { read: null, write: null };

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalize provider cache usage without confusing an absent field with zero.
 *  This is observation only: no cache hit is inferred from prompt size. */
export function extractCacheUsage(value: unknown): CacheUsage {
  if (!value || typeof value !== 'object') return absent;
  const root = value as Record<string, any>;
  const usage = (root.usage && typeof root.usage === 'object' ? root.usage : root) as Record<string, any>;
  const metadata = usage.usageMetadata && typeof usage.usageMetadata === 'object' ? usage.usageMetadata : usage;
  const promptDetails = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const read = numberOrNull(
    usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens
      ?? usage.cached_tokens
      ?? promptDetails?.cached_tokens
      ?? metadata.cachedContentTokenCount
      ?? metadata.cached_content_token_count,
  );
  const write = numberOrNull(
    usage.cache_creation_input_tokens
      ?? usage.cacheCreationInputTokens
      ?? usage.cache_write_input_tokens
      ?? usage.cacheWriteInputTokens
      ?? metadata.cacheCreationTokenCount
      ?? metadata.cache_creation_token_count,
  );
  return { read, write };
}

export function applyCacheUsage<T extends TokenUsage>(usage: T, value: unknown): T {
  const cache = extractCacheUsage(value);
  if (cache.read != null) {
    usage.prompt_tokens_details = { ...(usage.prompt_tokens_details ?? {}), cached_tokens: cache.read };
    usage.cache_read_input_tokens = cache.read;
  }
  if (cache.write != null) usage.cache_creation_input_tokens = cache.write;
  return usage;
}
