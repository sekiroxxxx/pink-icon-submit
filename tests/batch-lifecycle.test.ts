import assert from 'node:assert/strict';
import test from 'node:test';

import { canResumeDraftPullRequest, canRetryBatch, type BatchLifecycleSnapshot } from '../src/batch-lifecycle.js';

function failed(errorCode: string, checkpoint: BatchLifecycleSnapshot['delivery']['checkpoint']): BatchLifecycleSnapshot {
  return {
    state: 'FAILED',
    executionMode: 'remote',
    baseCommit: 'a'.repeat(40),
    validation: null,
    errorCode,
    delivery: {
      checkpoint,
      branch: `bot/ICON-20260811-TIMEOUT01`,
      commitSha: 'b'.repeat(40),
      pullRequest: null,
    },
  };
}

test('bounded infrastructure timeouts are manually recoverable at their safe checkpoints', () => {
  for (const code of [
    'GIT_COMMAND_TIMEOUT',
    'ICON_BATCH_COMMAND_TIMEOUT',
    'ICON_BATCH_DEPENDENCY_INSTALL_TIMEOUT',
  ]) {
    assert.equal(canRetryBatch(failed(code, 'NONE')), true, code);
  }
  for (const code of ['GIT_COMMAND_TIMEOUT', 'GITHUB_API_TIMEOUT']) {
    assert.equal(canResumeDraftPullRequest(failed(code, 'BRANCH_PUSHED')), true, code);
    assert.equal(canRetryBatch(failed(code, 'BRANCH_PUSHED')), true, code);
  }
});

test('unknown and program failures do not become retryable merely because they failed near delivery', () => {
  for (const code of ['WORKER_UNEXPECTED', 'ICON_BATCH_COMMAND_START_FAILED', 'DELIVERY_STATE_CONFLICT']) {
    assert.equal(canRetryBatch(failed(code, 'NONE')), false, code);
    assert.equal(canRetryBatch(failed(code, 'BRANCH_PUSHED')), false, code);
  }
});
