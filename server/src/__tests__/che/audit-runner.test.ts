import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, setSetting, getDb } from '../../db/index.js';
import { AUDIT_ENABLED_SETTING } from '../../che/audit-settings.js';

const require_ = createRequire(import.meta.url);
const tsx = path.join(path.dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const audit = fileURLToPath(new URL('../../che/model-audit.ts', import.meta.url));
const feed = fileURLToPath(new URL('../../che/feed-export.ts', import.meta.url));
const runnerRoot = fileURLToPath(new URL('../../../', import.meta.url));
let tmpDir: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
  dbPath = path.join(tmpDir, 'unwalled.db');
  env = {
    ...process.env,
    FREEAPI_DB_PATH: dbPath,
    ENCRYPTION_KEY: '0'.repeat(64),
    CHE_FEED_KEY_PATH: path.join(tmpDir, 'must-not-read.pem'),
    CHE_FEED_OUT: path.join(tmpDir, 'feed'),
    NODE_ENV: 'production',
  };
  delete env.CHE_AUDIT_PLATFORMS;
  initDb(dbPath, { ensureDir: false });
  setSetting(AUDIT_ENABLED_SETTING, '0');
  getDb().close?.();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function run(script: string) {
  return spawnSync(process.execPath, [tsx, script], { env, cwd: runnerRoot, encoding: 'utf8', timeout: 60_000 });
}

describe('scheduled audit gates', () => {
  it('global-off audit skips before table creation or provider access', () => {
    const result = run(audit);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('CHE_AUDIT_DISABLED');
    const db = require_('better-sqlite3')(dbPath);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='che_model_audit'").get();
    expect(table).toBeUndefined();
    db.close();
  });

  it('global-off feed does not read the signing key or write output', () => {
    const result = run(feed);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('CHE_AUDIT_DISABLED');
    expect(fs.existsSync(path.join(tmpDir, 'feed'))).toBe(false);
  });
});
