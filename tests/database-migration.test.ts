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
  legacy.prepare(`
    INSERT INTO batches (
      id, title, description, design_url, submitter_name, submitter_email,
      state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `).run(
    'ICON-20260801-ABCDEF12',
    'Legacy batch',
    'Created before the P3 delivery fields.',
    'https://design.example.invalid/legacy',
    'Designer',
    'designer@example.invalid',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
  );
  legacy.close();

  const migrated = new BatchDatabase(databasePath);
  assert.equal(migrated.getBatch('ICON-20260801-ABCDEF12').executionMode, null);
  assert.deepEqual(migrated.getBatch('ICON-20260801-ABCDEF12').delivery, {
    checkpoint: 'NONE',
    branch: null,
    commitSha: null,
    pullRequest: null,
    handoffAt: null,
  });
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
  assert.deepEqual(columns.map((column) => column.name).filter((name) => [
    'execution_mode',
    'push_repository',
    'push_branch_prefix',
    'delivery_checkpoint',
    'delivery_branch',
    'delivery_commit_sha',
    'pr_number',
    'pr_url',
    'pr_state',
    'pr_is_draft',
    'pr_created_at',
    'handoff_at',
  ].includes(name)).sort(), [
    'delivery_branch',
    'delivery_checkpoint',
    'delivery_commit_sha',
    'execution_mode',
    'handoff_at',
    'pr_created_at',
    'pr_is_draft',
    'pr_number',
    'pr_state',
    'pr_url',
    'push_branch_prefix',
    'push_repository',
  ]);
  assert.deepEqual(migrations, [{ version: 1 }, { version: 2 }, { version: 3 }]);
});

test('persists a remote batch delivery context without storing a credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-delivery-context-'));
  const databasePath = join(root, 'service.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const database = new BatchDatabase(databasePath);
  const batch = database.createBatch(
    'ICON-20260806-ABCDEF12',
    {
      title: 'Remote context',
      description: 'P3 context persistence test',
      designUrl: 'https://design.example.invalid/p3',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
    {
      packageName: '@pink/codicons',
      requestedTag: 'beta',
      version: '0.0.46-test.1',
      integrity: 'sha512-test',
      sourceRepository: 'sud-global/pink-codicons',
      sourceCommit: 'a'.repeat(40),
    },
    { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    {
      executionMode: 'remote',
      pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
      pushBranchPrefix: 'bot/',
    },
  );
  database.close();

  assert.equal(batch.executionMode, 'remote');
  assert.equal(batch.pushRepository, 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test');
  assert.equal(batch.pushBranchPrefix, 'bot/');
  assert.deepEqual(batch.delivery, {
    checkpoint: 'NONE',
    branch: null,
    commitSha: null,
    pullRequest: null,
    handoffAt: null,
  });

  const inspection = new Database(databasePath, { readonly: true });
  const columns = inspection.prepare('PRAGMA table_info(batches)').all() as Array<{ name: string }>;
  inspection.close();
  assert.equal(columns.some((column) => /token|credential|secret/i.test(column.name)), false);
});

test('startup recovery preserves an already handed-off PR_CREATED batch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-pr-created-recovery-'));
  const databasePath = join(root, 'service.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const database = new BatchDatabase(databasePath);
  database.createBatch(
    'ICON-20260806-ABCDEF12',
    {
      title: 'Handoff recovery',
      description: 'Keep a completed PR handoff terminal after restart.',
      designUrl: 'https://design.example.invalid/p3-handoff',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
    {
      packageName: '@pink/codicons',
      requestedTag: 'beta',
      version: '0.0.46-test.1',
      integrity: 'sha512-test',
      sourceRepository: 'sud-global/pink-codicons',
      sourceCommit: 'a'.repeat(40),
    },
    { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    {
      executionMode: 'remote',
      pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
      pushBranchPrefix: 'bot/',
    },
  );
  database.queueJob('ICON-20260806-ABCDEF12');
  database.claimNextJob();
  const inspection = new Database(databasePath);
  inspection.prepare("UPDATE batches SET state = 'PR_CREATED' WHERE id = ?").run('ICON-20260806-ABCDEF12');
  inspection.close();

  assert.equal(database.recoverInterruptedJobs(), 1);
  assert.equal(database.getBatch('ICON-20260806-ABCDEF12').state, 'PR_CREATED');
  assert.equal(database.getJob('ICON-20260806-ABCDEF12')?.state, 'COMPLETED');
  database.close();
});

test('P3-C resumes a completed P3-B branch checkpoint for Draft PR delivery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-branch-resume-'));
  const databasePath = join(root, 'service.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const database = new BatchDatabase(databasePath);
  const batchId = 'ICON-20260806-ABCDEF12';
  database.createBatch(
    batchId,
    {
      title: 'Resume P3-B branch',
      description: 'A completed branch checkpoint must continue into P3-C.',
      designUrl: 'https://design.example.invalid/resume',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
    {
      packageName: '@pink/codicons',
      requestedTag: 'beta',
      version: '0.0.46-test.1',
      integrity: 'sha512-test',
      sourceRepository: 'sud-global/pink-codicons',
      sourceCommit: 'a'.repeat(40),
    },
    { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    {
      executionMode: 'remote',
      pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
      pushBranchPrefix: 'bot/',
    },
  );
  database.queueJob(batchId);
  database.claimNextJob();
  database.recordCommitPrepared(batchId, { items: [] }, 'a'.repeat(40), { changedFiles: [] }, `bot/${batchId}`, 'b'.repeat(40));
  database.recordBranchPushed(batchId);
  database.completeAlreadyHandedOffJob(batchId);

  assert.equal(database.resumeBranchPushedJobs(), 1);
  assert.equal(database.getBatch(batchId).state, 'QUEUED');
  assert.equal(database.getBatch(batchId).delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(database.getJob(batchId)?.state, 'QUEUED');
  database.close();
});
