import type { Db } from '../db/types.js';
import { AGENTROUTER_BASE_URL, AGENTROUTER_RESPONSES_ONLY_MODELS } from '../lib/responses-upstream.js';
import { discoverEndpointModels, ModelDiscoveryError, type DiscoveredModel } from './model-discovery.js';
import { ensureModelInProfiles } from './profile-models.js';
import { customModelSeed } from './custom-model-seed.js';
import { decrypt } from '../lib/crypto.js';

// ── AgentRouter built-in platform: model discovery + registration (che.24) ──
//
// The built-in 'agentrouter' platform (fixed base URL https://agentrouter.org/v1,
// key-only onboarding) serves its models ONLY through the upstream Responses API
// and gates every endpoint on a claude-cli User-Agent — including /v1/models.
// So its models cannot ride the generic custom-endpoint paths:
//   - custom-model-sync only iterates 'custom' endpoints, and
//   - even where it could run, AgentRouter's /v1/models answers 401/403 to a
//     non-claude-cli UA, so discovery needs the UA built in.
//
// These three models are the operator's OWN credential on a fixed upstream —
// exactly the situation custom-model-register exists for (#488: "nobody has
// benchmarked this; seed the routing ranks at the catalog median"). Rows are
// therefore written with source='model_discovery' like operator-registered
// custom endpoint models, NEVER shipped as migration/catalog rows (the V25
// baseline in db/migrations/20260101_000000_legacy_baseline.ts is explicit
// that upstream-model catalog data is not seeded in code), so catalog-sync's
// "unknown platform row → source='catalog' → delete when absent" GC does not
// apply (see services/catalog-sync.ts, which gates on hasProvider AND the
// platform's catalog entries).

/** Result of one discovery/registration pass. */
export interface AgentRouterModelSyncResult {
  keyId: number;
  added: number;
  alreadyRegistered: number;
  models: Array<{ id: string; displayName: string }>;
}

/**
 * Discover AgentRouter's live /v1/models with the caller's key (the claude-cli
 * UA is applied by discoverEndpointModels) and register every row against the
 * platform's stored key. Idempotent: existing rows keep their ranks/toggles and
 * are re-bound to the freshest credential; new rows seed at the catalog median
 * (#488) and appear disabled in the no-profile default chain. An explicit
 * profile sync opts those models into auto-including profiles at the same
 * disabled state. Returns the registered set, gpt-6-astra first.
 */
export async function discoverAndRegisterAgentRouterModels(db: Db, keyId?: number, includeAutoProfiles = false): Promise<AgentRouterModelSyncResult> {
  const keyRow = db.prepare(
    `SELECT id, encrypted_key, iv, auth_tag FROM api_keys
      WHERE platform = 'agentrouter' AND enabled = 1 ${keyId === undefined ? '' : 'AND id = ?'}
      ORDER BY id LIMIT 1`,
  ).get(...(keyId === undefined ? [] : [keyId])) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!keyRow) {
    throw Object.assign(new Error('Add an enabled AgentRouter API key first'), { status: 400 });
  }

  const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

  let discovered: DiscoveredModel[];
  try {
    discovered = await discoverEndpointModels(AGENTROUTER_BASE_URL, apiKey);
  } catch (err) {
    // Discovery fetches the Operator's own credential against the Operator's
    // own fixed endpoint — a relayed failure is an upstream/operator problem,
    // not this dashboard session's auth. Same convention as
    // /api/keys/custom/discover-models.
    if (err instanceof ModelDiscoveryError) throw err;
    throw new ModelDiscoveryError(502, `AgentRouter model discovery failed: ${(err as Error)?.message ?? 'unknown error'}`);
  }

  const preferredOrder = (a: DiscoveredModel, b: DiscoveredModel): number => {
    const rank = (m: DiscoveredModel) => {
      if (m.id === 'gpt-6-astra') return 0;
      if (AGENTROUTER_RESPONSES_ONLY_MODELS.has(m.id)) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  };
  const sorted = [...discovered]
    // The UI must not advertise an id that its built-in adapter cannot call.
    // Discovery is key-onboarding, not an invitation to enable arbitrary new
    // upstream ids without a tested wire protocol.
    .filter(model => AGENTROUTER_RESPONSES_ONLY_MODELS.has(model.id))
    .sort(preferredOrder);
  if (sorted.length === 0) {
    throw new ModelDiscoveryError(502, 'AgentRouter returned none of its supported Responses models');
  }
  const seed = customModelSeed(db);

  const models: Array<{ id: string; displayName: string }> = [];
  let added = 0;
  let alreadyRegistered = 0;

  db.transaction(() => {
    for (const model of sorted) {
      const existing = db.prepare(
        "SELECT id FROM models WHERE platform = 'agentrouter' AND model_id = ?",
      ).get(model.id) as { id: number } | undefined;
      if (existing) alreadyRegistered += 1;

      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
           enabled, key_id, supports_tools, supports_vision, source, endpoint_scope)
        VALUES ('agentrouter', @modelId, @displayName, @intelligenceRank, @speedRank, @sizeLabel,
           NULL, NULL, NULL, NULL, '', @contextWindow, @enabled, @keyId, 1, 0, 'model_discovery', '')
        ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET
          display_name = excluded.display_name,
          key_id = excluded.key_id,
          context_window = COALESCE(models.context_window, excluded.context_window)
      `).run({
        enabled: existing ? 0 : 1,
        modelId: model.id,
        displayName: model.id,
        keyId: keyRow.id,
        contextWindow: model.contextWindow ?? null,
        intelligenceRank: seed.intelligenceRank,
        speedRank: seed.speedRank,
        sizeLabel: seed.sizeLabel,
      });

      const row = db.prepare(
        "SELECT id, display_name FROM models WHERE platform = 'agentrouter' AND model_id = ?",
      ).get(model.id) as { id: number; display_name: string };

      // Keep the models visible without silently putting a paid upstream on an
      // active chain. ensureModelInProfiles copies this disabled state; only
      // the operator's later explicit chain edit enables the model.
      const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(row.id);
      if (!inChain) {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)').run(row.id, max.m + 1);
      }
      if (includeAutoProfiles) ensureModelInProfiles(db, row.id);

      models.push({ id: model.id, displayName: row.display_name });
      if (!existing) added += 1;
    }
  })();

  return { keyId: keyRow.id, added, alreadyRegistered, models };
}
