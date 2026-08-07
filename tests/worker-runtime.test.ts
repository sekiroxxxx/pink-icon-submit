import assert from 'node:assert/strict';
import test from 'node:test';

import { startWorkerRuntime } from '../src/worker-runtime.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

async function createSubmittedBatch(environment: TestEnvironment, suffix: string): Promise<string> {
  const batch = await environment.batches.createBatch({
    title: `Worker runtime ${suffix}`,
    description: 'Exercise the process-level Worker enable switch.',
    designUrl: `https://design.example.invalid/worker-runtime-${suffix}`,
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: `worker-runtime-${suffix}`,
    description: 'Worker runtime test icon',
  }, Buffer.from(environment.validSvg));
  environment.batches.submit((await environment.batches.validateBatch(batch.id)).id);
  return batch.id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail('Timed out waiting for the Worker poll timer.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('disabled Worker runtime leaves queued and running jobs untouched in API-only mode', async (t) => {
  const environment = await createTestEnvironment(t);
  const branchPushedBatchId = await createSubmittedBatch(environment, 'branch-pushed');
  const branchPushedJob = environment.database.claimNextJob();
  assert.ok(branchPushedJob);
  assert.equal(branchPushedJob.batchId, branchPushedBatchId);
  environment.database.recordCommitPrepared(
    branchPushedBatchId,
    { items: [] },
    'a'.repeat(40),
    { changedFiles: [] },
    `bot/${branchPushedBatchId}`,
    'b'.repeat(40),
  );
  environment.database.recordBranchPushed(branchPushedBatchId);
  environment.database.completeBranchPushedJob(branchPushedBatchId);
  const branchPushedBatchBefore = environment.batches.getBatch(branchPushedBatchId);
  const branchPushedJobBefore = environment.database.getJob(branchPushedBatchId);
  assert.equal(branchPushedBatchBefore.state, 'BRANCH_PUSHED');
  assert.equal(branchPushedBatchBefore.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(branchPushedJobBefore?.state, 'COMPLETED');

  const firstBatchId = await createSubmittedBatch(environment, 'first');
  const secondBatchId = await createSubmittedBatch(environment, 'second');
  const runningJob = environment.database.claimNextJob();
  assert.ok(runningJob);
  const queuedBatchId = runningJob.batchId === firstBatchId ? secondBatchId : firstBatchId;

  let preflightCalls = 0;
  let workerConstructionCalls = 0;
  const runtime = await startWorkerRuntime({
    enabled: false,
    pollIntervalMs: 1,
    deliveryPhase: 'pull_request',
    recovery: environment.database,
    preflight: async () => { preflightCalls += 1; },
    createWorker: () => {
      workerConstructionCalls += 1;
      return { processNext: async () => ({ processed: false }) };
    },
    onError: () => assert.fail('A disabled Worker must not report processing errors.'),
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(preflightCalls, 0);
  assert.equal(workerConstructionCalls, 0);
  assert.equal(environment.batches.getBatch(runningJob.batchId).state, 'RUNNING');
  assert.equal(environment.database.getJob(runningJob.batchId)?.state, 'RUNNING');
  assert.equal(environment.batches.getBatch(queuedBatchId).state, 'QUEUED');
  assert.equal(environment.database.getJob(queuedBatchId)?.state, 'QUEUED');
  const branchPushedBatchAfter = environment.batches.getBatch(branchPushedBatchId);
  const branchPushedJobAfter = environment.database.getJob(branchPushedBatchId);
  assert.equal(branchPushedBatchAfter.state, branchPushedBatchBefore.state);
  assert.deepEqual(branchPushedBatchAfter.delivery, branchPushedBatchBefore.delivery);
  assert.deepEqual(branchPushedJobAfter && {
    state: branchPushedJobAfter.state,
    attempt: branchPushedJobAfter.attempt,
    error: branchPushedJobAfter.error,
  }, branchPushedJobBefore && {
    state: branchPushedJobBefore.state,
    attempt: branchPushedJobBefore.attempt,
    error: branchPushedJobBefore.error,
  });
  runtime.close();
});

test('enabled Worker runtime preserves topology preflight, recovery, and polling', async () => {
  let preflightCalls = 0;
  let recoverInterruptedJobsCalls = 0;
  let resumeBranchPushedJobsCalls = 0;
  let workerConstructionCalls = 0;
  let processNextCalls = 0;
  let releaseFirstPoll!: () => void;
  let resolveFirstPollFinished!: () => void;
  const firstPollFinished = new Promise<void>((resolve) => { resolveFirstPollFinished = resolve; });
  const runtime = await startWorkerRuntime({
    enabled: true,
    pollIntervalMs: 10,
    deliveryPhase: 'pull_request',
    recovery: {
      recoverInterruptedJobs: () => {
        recoverInterruptedJobsCalls += 1;
        return 0;
      },
      resumeBranchPushedJobs: () => {
        resumeBranchPushedJobsCalls += 1;
        return 0;
      },
    },
    preflight: async () => { preflightCalls += 1; },
    createWorker: () => {
      workerConstructionCalls += 1;
      return {
        processNext: async () => {
          processNextCalls += 1;
          if (processNextCalls === 1) {
            await new Promise<void>((resolve) => { releaseFirstPoll = resolve; });
            resolveFirstPollFinished();
          }
          return { processed: false };
        },
      };
    },
    onError: () => assert.fail('The test worker does not throw.'),
  });

  await waitFor(() => processNextCalls > 0);
  runtime.close();
  releaseFirstPoll();
  await firstPollFinished;
  const callsAfterClose = processNextCalls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(preflightCalls, 1);
  assert.equal(recoverInterruptedJobsCalls, 1);
  assert.equal(resumeBranchPushedJobsCalls, 1);
  assert.equal(workerConstructionCalls, 1);
  assert.equal(callsAfterClose, 1);
  assert.equal(processNextCalls, callsAfterClose);
});
