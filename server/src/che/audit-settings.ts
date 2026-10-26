import { getDb, getSetting, setSetting } from '../db/index.js';

/** Audit scheduling and provider cost are separate concerns: this switch only
 * controls the daily discovery/probe runner (and its feed export), never
 * routed traffic. Paid/mixed platforms require an explicit opt-in because even
 * quarantined discovery candidates may be probed once. */
export const PAID_MIXED_PLATFORMS = new Set(['siliconflow', 'siliconflow-cn']);
export const AUDIT_ENABLED_SETTING = 'che_audit_enabled';
export const AUDIT_PLATFORMS_SETTING = 'che_audit_platform_overrides';

export interface AuditSettingsSnapshot {
  enabled: boolean;
  platform_overrides: Record<string, boolean>;
  paid_platforms: string[];
}

function storedOverrides(): Record<string, boolean> {
  const raw = getSetting(AUDIT_PLATFORMS_SETTING);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([platform, enabled]) => (
        /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(platform) && typeof enabled === 'boolean'
      )),
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function isAuditEnabled(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_ENABLED_SETTING) as { value: string } | undefined;
  // No row = default on. A row with an explicit 0 = disabled, even when the
  // database was just created during this very runner invocation.
  return row?.value !== '0';
}

export function isPlatformAuditEnabled(platform: string): boolean {
  const explicit = storedOverrides()[platform];
  return explicit ?? !PAID_MIXED_PLATFORMS.has(platform);
}

export function getAuditSettings(): AuditSettingsSnapshot {
  const explicit = storedOverrides();
  const configured = getDb().prepare('SELECT DISTINCT platform FROM api_keys WHERE enabled = 1').all() as Array<{ platform: string }>;
  const platforms = new Set([...configured.map(row => row.platform), ...Object.keys(explicit)]);
  const platform_overrides = Object.fromEntries(
    [...platforms].sort().map(platform => [platform, explicit[platform] ?? !PAID_MIXED_PLATFORMS.has(platform)]),
  );
  return { enabled: isAuditEnabled(), platform_overrides, paid_platforms: [...PAID_MIXED_PLATFORMS].sort() };
}

export function updateAuditSettings(patch: { enabled?: boolean; platform_overrides?: Record<string, boolean> }): AuditSettingsSnapshot {
  if (patch.enabled !== undefined) setSetting(AUDIT_ENABLED_SETTING, patch.enabled ? '1' : '0');
  if (patch.platform_overrides !== undefined) {
    const merged = { ...storedOverrides(), ...patch.platform_overrides };
    setSetting(AUDIT_PLATFORMS_SETTING, JSON.stringify(merged));
  }
  return getAuditSettings();
}
