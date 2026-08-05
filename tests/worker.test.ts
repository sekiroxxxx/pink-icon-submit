import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalDiffWorker } from '../src/worker.js';
import { createTestEnvironment } from './helpers.js';

test('worker replans against a temporary upstream worktree and stores the allowed local diff', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = environment.batches.createBatch({
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
