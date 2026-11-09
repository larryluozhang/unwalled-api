import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routePinnedModel, resetRoutingRuntimeStateForTest } from '../../services/router.js';
import { getKeyQuotaSnapshots } from '../../services/provider-quota.js';
import { setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

// P0: smart/pace key selection (Magpie alignment).
// Fixed-clock assertions on which key wins when several candidates exist.

function insertKey(platform: string, id: number, label: string) {
  const enc = encrypt('test-api-key-' + label);
  getDb().prepare("INSERT INTO api_keys (id, platform, encrypted_key, iv, auth_tag, status, enabled, label) VALUES (?, ?, ?, ?, ?, 'healthy', 1, ?)").run(id, platform, enc.encrypted, enc.iv, enc.authTag, label);
}
function insertModel(platform: string, modelId: string) {
  getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools, source, endpoint_scope)
    VALUES (?, ?, ?, 1, 1, 'M', 'free', 1, 0, 0, 'custom', '')`).run(platform, modelId, modelId);
}
function insertQuota(platform: string, keyId: number, metric: string, limit: number, remaining: number, resetAt: string, confidence = 0.9) {
  getDb().prepare(`INSERT INTO provider_quota_state (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', 'header', ?)`).run(platform, keyId, 'groq::account', metric, limit, remaining, resetAt, confidence);
}

describe('smart/pace key selection', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetRoutingRuntimeStateForTest();
    setSetting('key_selection_strategy', 'smart');
    insertModel('groq', 'test-model');
    insertKey('groq', 1, 'k1');
    insertKey('groq', 2, 'k2');
    insertKey('groq', 3, 'k3');
  });
  afterEach(() => {
    setSetting('key_selection_strategy', 'auto');
  });

  it('smart: sooner reset wins', () => {
    // k1 resets in 1h, k2 in 2h, k3 in 3h — k1 should be picked first.
    const now = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 7200_000).toISOString();
    const latest = new Date(Date.now() + 10800_000).toISOString();
    insertQuota('groq', 1, 'requests', 1000, 900, now);
    insertQuota('groq', 2, 'requests', 1000, 500, later);
    insertQuota('groq', 3, 'requests', 1000, 100, latest);
    const modelId = (getDb().prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;
    const route = routePinnedModel(modelId);
    expect(route).not.toBeNull();
    expect(route!.keyId).toBe(1);
  });

  it('smart: exhausted keys skipped even if sooner reset', () => {
    const now = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 7200_000).toISOString();
    insertQuota('groq', 1, 'requests', 1000, 0, now); // exhausted
    insertQuota('groq', 2, 'requests', 1000, 500, later);
    const modelId = (getDb().prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;
    const route = routePinnedModel(modelId);
    expect(route).not.toBeNull();
    expect(route!.keyId).toBe(2);
  });

  it('pace: most remaining-per-hour wins', () => {
    setSetting('key_selection_strategy', 'pace');
    const now = Date.now();
    const in1h = new Date(now + 3600_000).toISOString();
    const in2h = new Date(now + 7200_000).toISOString();
    // k1: 900 left / 1h = 900/h; k2: 500 left / 2h = 250/h — k1 wins.
    insertQuota('groq', 1, 'requests', 1000, 900, in1h);
    insertQuota('groq', 2, 'requests', 1000, 500, in2h);
    const modelId = (getDb().prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;
    expect(getKeyQuotaSnapshots('groq', 'test-model')).toMatchObject([
      { keyId: 1, remainingRatio: 0.9 },
      { keyId: 2, remainingRatio: 0.5 },
    ]);
    const route = routePinnedModel(modelId);
    expect(route).not.toBeNull();
    expect(route!.keyId).toBe(1);
  });

  it('auto: no smart/pace ranking applied (backward compat)', () => {
    setSetting('key_selection_strategy', 'auto');
    const now = new Date(Date.now() + 3600_000).toISOString();
    insertQuota('groq', 1, 'requests', 1000, 900, now);
    // k1 should be picked by bandit/round-robin, NOT by smart order.
    const modelId = (getDb().prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;
    const route = routePinnedModel(modelId);
    expect(route).not.toBeNull();
    // auto = bandit; k1 is first key, expected.
    expect(route!.keyId).toBe(1);
  });
});
