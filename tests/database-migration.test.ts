import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BatchDatabase } from '../src/database.js';

test('migrates an existing database to the Stage 1 v2 batch protocol fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-migration-'));
  const databasePath = join(root, 'legacy.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      design_url TEXT NOT NULL,
      submitter_name TEXT NOT NULL,
      submitter_email TEXT NOT NULL,
      state TEXT NOT NULL,
      validation_json TEXT,
      warning_ack_request_sha256 TEXT,
      plan_json TEXT,
      base_commit TEXT,
      local_diff_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const migrated = new BatchDatabase(databasePath);
  migrated.close();

  const inspection = new Database(databasePath, { readonly: true });
  const columns = inspection.prepare('PRAGMA table_info(batches)').all() as Array<{ name: string }>;
  const migrations = inspection.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  inspection.close();
  assert.deepEqual(columns.map((column) => column.name).filter((name) => name.endsWith('_json')).sort(), [
    'catalog_baseline_json',
    'local_diff_json',
    'plan_json',
    'target_repository_json',
    'validation_json',
  ]);
  assert.deepEqual(migrations, [{ version: 1 }, { version: 2 }]);
});
