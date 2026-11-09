import crypto from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { extractCacheUsage } from '../lib/usage-cache.js';

const MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 5 * 60_000;
const WORTH_TOKENS = 1024;

interface AffinityEntry {
  modelDbId: number;
  keyId: number;
  endpointScope: string;
  prefixHash: string;
  toolsHash: string;
  at: number;
  ttlMs: number;
  confidence: number;
}

export interface AffinityContext {
  sessionKey: string;
  profileScope?: string;
  clientIdentity?: string;
  mode?: 'legacy' | 'cache';
}

export interface AffinityCandidate {
  id: number;
}

export interface AffinitySuccess {
  modelDbId: number;
  keyId: number;
  endpointScope?: string;
  usage?: unknown;
  now?: number;
  ttlMs?: number;
}

const entries = new Map<string, AffinityEntry>();

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function prefixOf(messages: ChatMessage[], tools?: unknown): { prefixHash: string; toolsHash: string } {
  const stable = messages.map(message => ({
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls,
    cache_control: (message as any).cache_control,
  }));
  return { prefixHash: digest(stable), toolsHash: digest(tools ?? []) };
}

function keyFor(ctx: AffinityContext): string {
  return `${ctx.clientIdentity ?? 'anonymous'}::${ctx.profileScope ?? 'default'}::${ctx.sessionKey}`;
}

function usable(ctx: AffinityContext): boolean {
  return ctx.mode === 'cache' && !!ctx.sessionKey;
}

function prune(now: number): void {
  for (const [key, value] of entries) {
    if (now - value.at > value.ttlMs) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    entries.delete(oldest[0]);
  }
}

/** Soft preference only. The caller must still apply every health, quota,
 *  scope, context and concurrency gate to the returned candidate list. */
export function preferCacheAffinity<T extends AffinityCandidate>(
  ctx: AffinityContext,
  modelDbId: number,
  endpointScope: string,
  candidates: T[],
  messages: ChatMessage[],
  tools?: unknown,
  now = Date.now(),
): T[] {
  if (!usable(ctx) || candidates.length < 2) return candidates;
  prune(now);
  const entry = entries.get(keyFor(ctx));
  if (!entry || entry.modelDbId !== modelDbId || entry.endpointScope !== endpointScope) return candidates;
  if (now - entry.at > entry.ttlMs) return candidates;
  const { prefixHash, toolsHash } = prefixOf(messages, tools);
  if (entry.toolsHash !== toolsHash) return candidates;
  // The first request establishes a prefix; subsequent turns may append. A
  // changed system/tool/history prefix is not safe to keep pinned.
  if (entry.prefixHash !== prefixHash) return candidates;
  const index = candidates.findIndex(candidate => candidate.id === entry.keyId);
  if (index <= 0) return candidates;
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

export function recordCacheAffinitySuccess(
  ctx: AffinityContext,
  messages: ChatMessage[],
  tools: unknown,
  success: AffinitySuccess,
): void {
  if (!usable(ctx)) return;
  const usage = extractCacheUsage(success.usage);
  // Only a provider-reported cache read is strong evidence. Creation alone is
  // retained as weak evidence and must not force a key choice.
  if (usage.read == null || usage.read < WORTH_TOKENS) return;
  const { prefixHash, toolsHash } = prefixOf(messages, tools);
  const key = keyFor(ctx);
  entries.set(key, {
    modelDbId: success.modelDbId,
    keyId: success.keyId,
    endpointScope: success.endpointScope ?? '',
    prefixHash,
    toolsHash,
    at: success.now ?? Date.now(),
    ttlMs: success.ttlMs ?? DEFAULT_TTL_MS,
    confidence: 1,
  });
  prune(success.now ?? Date.now());
}

export function clearCacheAffinity(): void {
  entries.clear();
}

export function cacheAffinitySize(): number {
  return entries.size;
}

export const CACHE_WORTH_TOKENS = WORTH_TOKENS;
export const DEFAULT_CACHE_TTL_MS = DEFAULT_TTL_MS;
