import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BatchDatabase } from '../src/database.js';

test('migrates a real v1-v4 fixture to ownership without losing batch, item, job, failure, or handoff evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-migration-'));
  const databasePath = join(root, 'legacy.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations (version) VALUES (1), (2), (3), (4);
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
      catalog_baseline_json TEXT,
      target_repository_json TEXT,
      execution_mode TEXT,
      push_repository TEXT,
      push_branch_prefix TEXT,
      delivery_checkpoint TEXT NOT NULL DEFAULT 'NONE',
      delivery_branch TEXT,
      delivery_commit_sha TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      pr_state TEXT,
      pr_is_draft INTEGER,
      pr_created_at TEXT,
      handoff_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      design_name TEXT,
      target_name TEXT,
      description TEXT,
      reason TEXT,
      replacement_name TEXT,
      source_file TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      batch_id TEXT PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_failures (
      id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      error_code TEXT NOT NULL,
      error_message TEXT NOT NULL,
      operation TEXT,
      command_text TEXT,
      exit_code INTEGER,
      stderr_summary TEXT,
      created_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO batches (
      id, title, description, design_url, submitter_name, submitter_email,
      state, validation_json, warning_ack_request_sha256, plan_json, base_commit, local_diff_json,
      error_code, error_message, catalog_baseline_json, target_repository_json,
      execution_mode, push_repository, push_branch_prefix, delivery_checkpoint, delivery_branch,
      delivery_commit_sha, pr_number, pr_url, pr_state, pr_is_draft, pr_created_at, handoff_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ICON-20260801-ABCDEF12',
    'Legacy batch',
    'Created before the ownership migration.',
    'https://design.example.invalid/legacy',
    'Designer',
    'designer@example.invalid',
    'FAILED',
    JSON.stringify({ schemaVersion: 1, valid: false, requestSha256: 'a'.repeat(64), errors: [{ code: 'SVG_LITERAL_COLOR' }], warnings: [] }),
    'a'.repeat(64),
    JSON.stringify({ schemaVersion: 1, items: [{ id: 'item-v4' }] }),
    'b'.repeat(40),
    JSON.stringify({ files: [{ path: 'src/icons/legacy.svg' }] }),
    'GIT_COMMAND_FAILED',
    'A redacted command failed.',
    JSON.stringify({ packageName: '@pink/codicons', requestedTag: 'beta', version: '0.0.46-test.1', integrity: 'sha512-test', sourceRepository: 'sud-global/pink-codicons', sourceCommit: 'c'.repeat(40) }),
    JSON.stringify({ repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' }),
    'remote',
    'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    'bot/',
    'BRANCH_PUSHED',
    'bot/ICON-20260801-ABCDEF12',
    'd'.repeat(40),
    42,
    'https://github.example.invalid/pull/42',
    'open',
    1,
    '2026-08-01T00:05:00.000Z',
    '2026-08-01T00:06:00.000Z',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:07:00.000Z',
  );
  legacy.prepare(`
    INSERT INTO items (id, batch_id, action, design_name, target_name, description, reason, replacement_name, source_file, created_at)
    VALUES (?, ?, 'add', ?, NULL, ?, NULL, NULL, ?, ?)
  `).run('item-v4', 'ICON-20260801-ABCDEF12', 'legacy-icon', 'Retained uploaded SVG.', 'uploads/item-v4.svg', '2026-08-01T00:01:00.000Z');
  legacy.prepare(`
    INSERT INTO jobs (batch_id, state, attempt, error_code, error_message, created_at, updated_at)
    VALUES (?, 'FAILED', 3, 'GIT_COMMAND_FAILED', 'A redacted command failed.', ?, ?)
  `).run('ICON-20260801-ABCDEF12', '2026-08-01T00:02:00.000Z', '2026-08-01T00:07:00.000Z');
  legacy.prepare(`
    INSERT INTO job_failures (id, batch_id, attempt, error_code, error_message, operation, command_text, exit_code, stderr_summary, created_at)
    VALUES (1, ?, 3, 'GIT_COMMAND_FAILED', 'A redacted command failed.', 'fetch base', 'git fetch [REDACTED]', 128, 'TLS failure', ?)
  `).run('ICON-20260801-ABCDEF12', '2026-08-01T00:07:00.000Z');
  legacy.close();

  const migrated = new BatchDatabase(databasePath);
  const details = migrated.getDetails('ICON-20260801-ABCDEF12');
  assert.equal(details.title, 'Legacy batch');
  assert.equal(details.description, 'Created before the ownership migration.');
  assert.equal(details.designUrl, 'https://design.example.invalid/legacy');
  assert.deepEqual(details.submitter, { name: 'Designer', email: 'designer@example.invalid' });
  assert.equal(details.state, 'FAILED');
  assert.equal(details.createdAt, '2026-08-01T00:00:00.000Z');
  assert.equal(details.updatedAt, '2026-08-01T00:07:00.000Z');
  assert.deepEqual(details.catalogBaseline, {
    packageName: '@pink/codicons',
    requestedTag: 'beta',
    version: '0.0.46-test.1',
    integrity: 'sha512-test',
    sourceRepository: 'sud-global/pink-codicons',
    sourceCommit: 'c'.repeat(40),
  });
  assert.deepEqual(details.targetRepository, { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' });
  assert.equal(details.executionMode, 'remote');
  assert.equal(details.pushRepository, 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test');
  assert.equal(details.pushBranchPrefix, 'bot/');
  assert.deepEqual(details.validation, { schemaVersion: 1, valid: false, requestSha256: 'a'.repeat(64), errors: [{ code: 'SVG_LITERAL_COLOR' }], warnings: [] });
  assert.equal(details.warningsAcknowledged, true);
  assert.deepEqual(details.plan, { schemaVersion: 1, items: [{ id: 'item-v4' }] });
  assert.deepEqual(details.localDiff, { files: [{ path: 'src/icons/legacy.svg' }] });
  assert.equal(details.baseCommit, 'b'.repeat(40));
  assert.deepEqual(details.error, { code: 'GIT_COMMAND_FAILED', message: 'A redacted command failed.' });
  assert.deepEqual(details.delivery, {
    checkpoint: 'BRANCH_PUSHED',
    branch: 'bot/ICON-20260801-ABCDEF12',
    commitSha: 'd'.repeat(40),
    pullRequest: { number: 42, url: 'https://github.example.invalid/pull/42', state: 'open', isDraft: true, createdAt: '2026-08-01T00:05:00.000Z' },
    handoffAt: '2026-08-01T00:06:00.000Z',
  });
  assert.deepEqual(details.items.map((item) => ({ id: item.id, sourceFile: item.sourceFile, createdAt: item.createdAt })), [{ id: 'item-v4', sourceFile: 'uploads/item-v4.svg', createdAt: '2026-08-01T00:01:00.000Z' }]);
  assert.deepEqual(details.job, { batchId: 'ICON-20260801-ABCDEF12', state: 'FAILED', attempt: 3, error: { code: 'GIT_COMMAND_FAILED', message: 'A redacted command failed.' }, createdAt: '2026-08-01T00:02:00.000Z', updatedAt: '2026-08-01T00:07:00.000Z' });
  assert.deepEqual(details.failureHistory, [{ id: 1, batchId: 'ICON-20260801-ABCDEF12', attempt: 3, code: 'GIT_COMMAND_FAILED', message: 'A redacted command failed.', operation: 'fetch base', command: 'git fetch [REDACTED]', exitCode: 128, stderr: 'TLS failure', createdAt: '2026-08-01T00:07:00.000Z' }]);
  migrated.close();

  const reopened = new BatchDatabase(databasePath);
  assert.equal(reopened.getDetails('ICON-20260801-ABCDEF12').items.length, 1);
  reopened.close();

  const inspection = new Database(databasePath, { readonly: true });
  const columns = inspection.prepare('PRAGMA table_info(batches)').all() as Array<{ name: string }>;
  const migrations = inspection.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const jobFailuresTable = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_failures'").get();
  const usersTable = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const sessionsTable = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  const legacyOwner = inspection.prepare('SELECT owner_id FROM batches WHERE id = ?').get('ICON-20260801-ABCDEF12') as { owner_id: string };
  const legacyCloneNonce = inspection.prepare('SELECT clone_creation_nonce FROM batches WHERE id = ?').get('ICON-20260801-ABCDEF12') as { clone_creation_nonce: string | null };
  const legacyUserCount = inspection.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get('legacy-bootstrap') as { count: number };
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
  assert.deepEqual(migrations, [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
  assert.notEqual(jobFailuresTable, undefined);
  assert.notEqual(usersTable, undefined);
  assert.notEqual(sessionsTable, undefined);
  assert.equal(columns.some((column) => column.name === 'owner_id'), true);
  assert.equal(columns.some((column) => column.name === 'clone_creation_nonce'), true);
  assert.equal(legacyOwner.owner_id, 'legacy-bootstrap');
  assert.equal(legacyCloneNonce.clone_creation_nonce, null);
  assert.equal(legacyUserCount.count, 1);
});

test('retains redacted worker diagnostics after a retry clears the job error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-failure-history-'));
  const databasePath = join(root, 'service.sqlite');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const database = new BatchDatabase(databasePath);
  const batchId = 'ICON-20260806-ABCDEF12';
  database.createBatch(
    batchId,
    {
      title: 'Failure diagnostics',
      description: 'Persist a redacted command failure across retry.',
      designUrl: 'https://design.example.invalid/failure-history',
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
    { executionMode: 'remote', pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test', pushBranchPrefix: 'bot/' },
  );
  database.queueJob(batchId);
  database.claimNextJob();
  const token = 'gho_1234567890abcdefghij';
  database.failJob(batchId, 'GIT_COMMAND_FAILED', `fetch failed with ${token}`, {
    operation: 'git fetch',
    command: `git fetch https://sud-icon-bot:${token}@github.com/example/repository.git`,
    exitCode: 128,
    stderr: `fatal: password=${token} was rejected`,
  });

  const failed = database.getDetails(batchId);
  assert.equal(failed.failureHistory.length, 1);
  assert.deepEqual(failed.failureHistory[0], {
    id: 1,
    batchId,
    attempt: 1,
    code: 'GIT_COMMAND_FAILED',
    message: 'fetch failed with [REDACTED]',
    operation: 'git fetch',
    command: 'git fetch https://[REDACTED]@github.com/example/repository.git',
    exitCode: 128,
    stderr: 'fatal: password=[REDACTED] was rejected',
    createdAt: failed.failureHistory[0]!.createdAt,
  });

  database.queueJob(batchId);
  const retried = database.getDetails(batchId);
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.job?.error, null);
  assert.equal(retried.failureHistory.length, 1);
  assert.doesNotMatch(JSON.stringify(retried.failureHistory), new RegExp(token));
  database.close();
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
