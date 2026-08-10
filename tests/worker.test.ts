import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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
  environment.batches.submit(batch.id);

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
  environment.batches.submit((await environment.batches.validateBatch(batch.id)).id);

  const outcome = await new LocalDiffWorker(environment.batches).processNext();
  assert.deepEqual(outcome, { processed: true, batchId: batch.id });

  const failed = environment.batches.getBatch(batch.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'DIFF_ALLOWLIST_VIOLATION');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(await hasNoLegacyTemporaryEntries(environment.config.temporaryRoot), true);
});
