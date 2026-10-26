import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, setSetting, getDb } from '../../db/index.js';
import {
  AUDIT_ENABLED_SETTING,
  AUDIT_PLATFORMS_SETTING,
  getAuditSettings,
  isAuditEnabled,
  isPlatformAuditEnabled,
  updateAuditSettings,
} from '../../che/audit-settings.js';

describe('audit settings', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('preserves existing free auditing and defaults paid/mixed platforms off', () => {
    expect(isAuditEnabled()).toBe(true);
    expect(isPlatformAuditEnabled('groq')).toBe(true);
    expect(isPlatformAuditEnabled('siliconflow-cn')).toBe(false);
  });

  it('honors explicit paid opt-in and ordinary platform opt-out', () => {
    updateAuditSettings({ platform_overrides: { 'siliconflow-cn': true, groq: false } });
    expect(isPlatformAuditEnabled('siliconflow-cn')).toBe(true);
    expect(isPlatformAuditEnabled('groq')).toBe(false);
  });

  it('merges platform patches without materializing paid defaults', () => {
    updateAuditSettings({ platform_overrides: { groq: false } });
    updateAuditSettings({ platform_overrides: { modelscope: false } });
    expect(isPlatformAuditEnabled('groq')).toBe(false);
    expect(isPlatformAuditEnabled('modelscope')).toBe(false);
    expect(isPlatformAuditEnabled('siliconflow')).toBe(false);
  });

  it('keeps global off separate from platform choices', () => {
    updateAuditSettings({ enabled: false, platform_overrides: { groq: true } });
    expect(isAuditEnabled()).toBe(false);
    expect(isPlatformAuditEnabled('groq')).toBe(true);
    setSetting(AUDIT_ENABLED_SETTING, '1');
    expect(isAuditEnabled()).toBe(true);
  });

  it('does not enable paid platforms on corrupt stored JSON', () => {
    setSetting(AUDIT_PLATFORMS_SETTING, '{broken');
    expect(isPlatformAuditEnabled('siliconflow')).toBe(false);
    expect(getAuditSettings().platform_overrides).toEqual({});
  });

  it('lists effective choices for platforms with enabled keys', () => {
    const db = getDb();
    db.prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled) VALUES ('siliconflow', '', '', '', 1)").run();
    const snapshot = getAuditSettings();
    expect(snapshot.platform_overrides.siliconflow).toBe(false);
    expect(snapshot.paid_platforms).toContain('siliconflow-cn');
  });
});
