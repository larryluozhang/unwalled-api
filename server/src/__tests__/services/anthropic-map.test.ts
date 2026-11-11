import { describe, it, expect, beforeEach } from 'vitest';
import { classifyClaudeFamily, resolveAnthropicModel, setClaudeModelMap } from '../../services/anthropic-map.js';
import { initDb, getDb } from '../../db/index.js';

// classifyClaudeFamily maps a requested model alias to a Claude family (or null
// for a concrete catalog id). Claude Code's planning alias `opusplan` is
// opus-ish by name, but the operator map has no `opusplan` slot — it must fall
// through to the `default` family, as the function's own comment states.
describe('classifyClaudeFamily', () => {
  it('routes Claude Code opusplan aliases to the default family', () => {
    expect(classifyClaudeFamily('opusplan')).toBe('default');
    expect(classifyClaudeFamily('opusplan-4')).toBe('default');
    expect(classifyClaudeFamily('OpusPlan')).toBe('default');
  });

  it('still classifies real opus models as the opus family', () => {
    expect(classifyClaudeFamily('opus')).toBe('opus');
    expect(classifyClaudeFamily('claude-opus-4-1')).toBe('opus');
  });

  it('classifies the other Claude families and aliases as before', () => {
    expect(classifyClaudeFamily('claude-sonnet-4-5')).toBe('sonnet');
    expect(classifyClaudeFamily('claude-3-5-haiku')).toBe('haiku');
    expect(classifyClaudeFamily('claude-something-new')).toBe('default');
    expect(classifyClaudeFamily('')).toBe('default');
    expect(classifyClaudeFamily('auto')).toBe('default');
  });

  it('returns null for a non-Claude concrete catalog id', () => {
    expect(classifyClaudeFamily('llama-3.1-70b')).toBeNull();
  });
});

// resolveAnthropicModel honors the operator's family map. A family mapped to a
// named fallback chain (`auto:<profile>`) must surface namedProfile (so the
// caller routes the whole chain) instead of being looked up as a literal
// model_id and silently degrading to the Default chain.
describe('resolveAnthropicModel', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Seed a concrete catalog model so the pin path has something to find.
    getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools, source, endpoint_scope)
      VALUES ('google', 'test-pin-model', 'Test Pin Model', 1, 1, 'M', 'free', 1, 0, 0, 'custom', '')`).run();
  });

  it('auto (default) routes without pinning', () => {
    setClaudeModelMap({ sonnet: 'auto' });
    const r = resolveAnthropicModel('claude-sonnet-4-5');
    expect(r.pinned).toBe(false);
    expect(r.namedProfile).toBeUndefined();
    expect(r.preferredModelDbId).toBeUndefined();
  });

  it('a concrete catalog model id pins that model', () => {
    setClaudeModelMap({ sonnet: 'test-pin-model' });
    const r = resolveAnthropicModel('claude-sonnet-4-5');
    expect(r.pinned).toBe(true);
    expect(r.modelId).toBe('test-pin-model');
    expect(r.namedProfile).toBeUndefined();
  });

  it('a family mapped to auto:<profile> surfaces namedProfile, not a pin', () => {
    setClaudeModelMap({ sonnet: 'auto:cc-main', opus: 'auto:cc-classifier' });
    const s = resolveAnthropicModel('claude-sonnet-4-5');
    expect(s.pinned).toBe(false);
    expect(s.namedProfile).toBe('cc-main');
    expect(s.preferredModelDbId).toBeUndefined();
    const o = resolveAnthropicModel('claude-opus-4-1');
    expect(o.namedProfile).toBe('cc-classifier');
  });

  it('subagent alias routes to the subagent family slot', () => {
    setClaudeModelMap({ subagent: 'auto:cc-classifier' });
    const r = resolveAnthropicModel('subagent');
    expect(r.namedProfile).toBe('cc-classifier');
    expect(r.pinned).toBe(false);
    // also the claude-subagent form
    const r2 = resolveAnthropicModel('claude-subagent');
    expect(r2.namedProfile).toBe('cc-classifier');
    // main model stays on its own slot, not the subagent slot
    setClaudeModelMap({ sonnet: 'auto:cc-main', subagent: 'auto:cc-classifier' });
    expect(resolveAnthropicModel('claude-sonnet-4-5').namedProfile).toBe('cc-main');
  });

  it('fable alias routes to the fable family slot', () => {
    setClaudeModelMap({ fable: 'auto:cc-main' });
    const r = resolveAnthropicModel('claude-fable-5-1');
    expect(r.namedProfile).toBe('cc-main');
    // main sonnet slot is independent
    setClaudeModelMap({ sonnet: 'auto:cc-classifier', fable: 'auto:cc-main' });
    expect(resolveAnthropicModel('claude-sonnet-4-5').namedProfile).toBe('cc-classifier');
    expect(resolveAnthropicModel('claude-fable-5').namedProfile).toBe('cc-main');
  });

  it('a pinned-but-disabled model degrades to auto, not namedProfile', () => {
    getDb().prepare("UPDATE models SET enabled=0 WHERE model_id='test-pin-model'").run();
    setClaudeModelMap({ sonnet: 'test-pin-model' });
    const r = resolveAnthropicModel('claude-sonnet-4-5');
    expect(r.pinned).toBe(false);
    expect(r.namedProfile).toBeUndefined();
  });
});
