import type { Db } from '../types.js';

export function up(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='cache_stickiness_mode'").get();
  if (!has) db.exec("ALTER TABLE profiles ADD COLUMN cache_stickiness_mode TEXT NOT NULL DEFAULT 'legacy'");
}

export function down(db: Db): void {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name='cache_stickiness_mode'").get();
  if (has) db.exec('ALTER TABLE profiles DROP COLUMN cache_stickiness_mode');
}
