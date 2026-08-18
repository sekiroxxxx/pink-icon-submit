import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { LocalDiffWorker } from '../src/worker.js';
import { createTestEnvironment } from './helpers.js';

async function hasNoLegacyTemporaryEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

test('worker replans against a temporary target worktree and stores the allowed local diff', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Worker add',
    description: 'Worker test batch',
    designUrl: 'https://design.example.invalid/worker',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'worker-icon',
    description: 'Worker icon',
  }, Buffer.from(environment.validSvg));
  const validated = await environment.batches.validateBatch(batch.id);
  assert.equal(validated.state, 'READY');
  await environment.batches.submit(batch.id);

  const worker = new LocalDiffWorker(environment.batches);
  const outcome = await worker.processNext();
  assert.deepEqual(outcome, { processed: true, batchId: batch.id });

  const completed = environment.batches.getBatch(batch.id);
  assert.equal(completed.state, 'LOCAL_DIFF_READY');
  assert.deepEqual((completed.localDiff as { changedFiles: string[] }).changedFiles, [
    'src/icons/worker-icon.svg',
    'src/template/mapping.json',
  ]);
  assert.equal(completed.job?.state, 'COMPLETED');
});

test('local worker runs and persists final Stage 1 validation for a queued delivery', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Final validation before local delivery',
    description: 'This batch intentionally skips the compatibility validation endpoint.',
    designUrl: 'https://design.example.invalid/final-local-validation',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'final-validation-local-icon',
    description: 'Final validation must run in the worker.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);

  await new LocalDiffWorker(environment.batches).processNext();

  const completed = environment.batches.getBatch(batch.id);
  assert.equal(completed.state, 'LOCAL_DIFF_READY');
  assert.equal((completed.validation as { valid?: unknown } | null)?.valid, true);
  assert.equal(completed.baseCommit, execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
});

test('local worker stops a final Stage 1 business failure at checkpoint NONE before plan or apply', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Blocked final validation',
    description: 'The fake Stage 1 fixture returns a business validation error.',
    designUrl: 'https://design.example.invalid/final-validation-failure',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'final-validation-failure',
    description: 'This must never reach plan or apply.',
  }, Buffer.from(environment.validSvg));
  const targetHead = execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  environment.database.queueJob(batch.id);

  await new LocalDiffWorker(environment.batches).processNext();

  const failed = environment.batches.getBatch(batch.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'NONE');
  assert.equal((failed.validation as { valid?: unknown } | null)?.valid, false);
  assert.equal(failed.baseCommit, targetHead);
  assert.equal(failed.plan, null);
  assert.equal(failed.localDiff, null);
  assert.equal(failed.error?.code, 'FINAL_VALIDATION_FAILED');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), targetHead);
  assert.equal(await hasNoLegacyTemporaryEntries(environment.config.temporaryRoot), true);
});

test('worker rejects an out-of-plan diff and removes its temporary worktree', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Unsafe worker add',
    description: 'Worker allowlist test',
    designUrl: 'https://design.example.invalid/unsafe-worker',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'unsafe-worker-icon',
    description: 'Unsafe worker icon',
  }, Buffer.from(environment.validSvg));
  await environment.batches.submit((await environment.batches.validateBatch(batch.id)).id);

  const outcome = await new LocalDiffWorker(environment.batches).processNext();
  assert.deepEqual(outcome, { processed: true, batchId: batch.id });

  const failed = environment.batches.getBatch(batch.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'DIFF_ALLOWLIST_VIOLATION');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(await hasNoLegacyTemporaryEntries(environment.config.temporaryRoot), true);
});

test('queueJob rolls back its job insert when the batch transition fails', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Atomic queue transition',
    description: 'The job and batch must enter QUEUED together.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const injector = new Database(environment.config.databasePath);
  injector.exec(`
    CREATE TRIGGER fail_atomic_queue
    BEFORE UPDATE OF state ON batches
    WHEN NEW.id = '${batch.id}' AND NEW.state = 'QUEUED'
    BEGIN SELECT RAISE(ABORT, 'simulated batch queue failure'); END;
  `);
  injector.close();

  assert.throws(() => environment.database.queueJob(batch.id), /simulated batch queue failure/);
  assert.equal(environment.database.getJob(batch.id), null);
  assert.equal(environment.database.getBatch(batch.id).state, 'DRAFT');
});

test('completeJob rolls back its job transition when the batch transition fails', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Atomic completion transition',
    description: 'The job and batch must complete together.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  environment.database.queueJob(batch.id);
  environment.database.claimNextJob();
  const injector = new Database(environment.config.databasePath);
  injector.exec(`
    CREATE TRIGGER fail_atomic_completion
    BEFORE UPDATE OF state ON batches
    WHEN NEW.id = '${batch.id}' AND NEW.state = 'LOCAL_DIFF_READY'
    BEGIN SELECT RAISE(ABORT, 'simulated batch completion failure'); END;
  `);
  injector.close();

  assert.throws(
    () => environment.database.completeJob(batch.id, { test: true }, 'a'.repeat(40), { changedFiles: [] }),
    /simulated batch completion failure/,
  );
  assert.equal(environment.database.getJob(batch.id)?.state, 'RUNNING');
  assert.equal(environment.database.getBatch(batch.id).state, 'RUNNING');
});

test('a failed item update leaves the worker reading the previously referenced SVG', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Immutable upload reference',
    description: 'A failed database update must not alter the referenced upload.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const item = await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'immutable-upload-icon',
    description: 'Original description',
  }, Buffer.from(environment.validSvg));
  const originalSourceFile = item.sourceFile!;
  const injector = new Database(environment.config.databasePath);
  injector.exec(`
    CREATE TRIGGER fail_item_source_switch
    BEFORE UPDATE ON items
    WHEN NEW.id = '${item.id}'
    BEGIN SELECT RAISE(ABORT, 'simulated item update failure'); END;
  `);
  injector.close();
  const replacementSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3h1v1H3z"/></svg>';

  await assert.rejects(
    () => environment.batches.updateItem(batch.id, item.id, {
      action: 'add',
      designName: 'immutable-upload-icon',
      description: 'Replacement description',
    }, Buffer.from(replacementSvg)),
    /simulated item update failure/,
  );
  assert.equal(environment.database.getItem(batch.id, item.id).sourceFile, originalSourceFile);
  assert.equal(
    await readFile(join(environment.config.storageRoot, batch.id, originalSourceFile), 'utf8'),
    environment.validSvg,
  );

  environment.database.queueJob(batch.id);
  await new LocalDiffWorker(environment.batches).processNext();
  assert.equal(environment.database.getJob(batch.id)?.state, 'COMPLETED');
});
