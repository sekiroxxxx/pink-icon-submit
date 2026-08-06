import assert from 'node:assert/strict';
import test from 'node:test';

import { BatchService } from '../src/batch-service.js';
import { catalogOptionsFromConfig } from '../src/config.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import type { IconBatchResult } from '../src/types.js';
import { createTestEnvironment } from './helpers.js';

class BlockingIconBatchCli extends IconBatchCli {
  private resolveStarted!: () => void;
  private resolveValidation!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly validation = new Promise<void>((resolve) => {
    this.resolveValidation = resolve;
  });

  override async validate(): Promise<IconBatchResult> {
    this.resolveStarted();
    await this.validation;
    return {
      exitCode: 0,
      payload: {
        schemaVersion: 1,
        valid: true,
        baseCommit: 'a'.repeat(40),
        summary: { errorCount: 0, warningCount: 0 },
        errors: [],
        warnings: [],
      },
    };
  }

  waitForValidation(): Promise<void> {
    return this.started;
  }

  finishValidation(): void {
    this.resolveValidation();
  }
}

function createBatch(batches: BatchService): string {
  return batches.createBatch({
    title: 'State test',
    description: 'State transition test',
    designUrl: 'https://design.example.invalid/state-test',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  }).id;
}

test('validation makes the batch immutable until it completes and rejects queued revalidation', async (t) => {
  const environment = await createTestEnvironment(t);
  const iconBatch = new BlockingIconBatchCli();
  const batches = new BatchService(
    environment.database,
    environment.batches.storage,
    environment.batches.repository,
    iconBatch,
    environment.config.maxUploadBytes,
    catalogOptionsFromConfig(environment.config),
  );
  const batchId = createBatch(batches);
  await batches.addItem(batchId, {
    action: 'add',
    designName: 'state-test-icon',
    description: 'State test icon',
  }, Buffer.from(environment.validSvg));

  const validation = batches.validateBatch(batchId);
  await iconBatch.waitForValidation();
  assert.equal(batches.getBatch(batchId).state, 'VALIDATING');

  await assert.rejects(
    batches.addItem(batchId, { action: 'delete', targetName: 'existing', reason: 'No longer needed' }, undefined),
    { code: 'BATCH_NOT_EDITABLE' },
  );
  await assert.rejects(batches.validateBatch(batchId), { code: 'BATCH_NOT_VALIDATABLE' });

  iconBatch.finishValidation();
  assert.equal((await validation).state, 'READY');
  assert.equal(batches.submit(batchId).state, 'QUEUED');
  await assert.rejects(batches.validateBatch(batchId), { code: 'BATCH_NOT_VALIDATABLE' });
});

test('interrupted RUNNING jobs become retryable failures on startup recovery', async (t) => {
  const environment = await createTestEnvironment(t);
  const batchId = createBatch(environment.batches);
  await environment.batches.addItem(batchId, {
    action: 'add',
    designName: 'recovery-test-icon',
    description: 'Recovery test icon',
  }, Buffer.from(environment.validSvg));
  environment.batches.submit((await environment.batches.validateBatch(batchId)).id);
  assert.equal(environment.database.claimNextJob()?.state, 'RUNNING');

  assert.equal(environment.database.recoverInterruptedJobs(), 1);
  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'WORKER_INTERRUPTED');
  assert.equal(failed.job?.state, 'FAILED');

  const retried = environment.batches.retry(batchId);
  assert.equal(retried.state, 'QUEUED');
  assert.equal(retried.job?.state, 'QUEUED');
  assert.equal(retried.job?.attempt, 2);
});

test('interrupted VALIDATING batches return to DRAFT on startup recovery', async (t) => {
  const environment = await createTestEnvironment(t);
  const batchId = createBatch(environment.batches);
  await environment.batches.addItem(batchId, {
    action: 'add',
    designName: 'validation-recovery-icon',
    description: 'Validation recovery icon',
  }, Buffer.from(environment.validSvg));
  environment.database.beginValidation(batchId);
  assert.equal(environment.batches.getBatch(batchId).state, 'VALIDATING');

  assert.equal(environment.database.recoverInterruptedValidations(), 1);
  assert.equal(environment.batches.getBatch(batchId).state, 'DRAFT');

  await environment.batches.addItem(batchId, {
    action: 'delete',
    targetName: 'existing',
    reason: 'Verifies editing is available after recovery.',
  }, undefined);
  assert.equal((await environment.batches.validateBatch(batchId)).state, 'READY');
});

test('editing a DRAFT batch clears an obsolete validation result and acknowledgement', async (t) => {
  const environment = await createTestEnvironment(t);
  const batchId = createBatch(environment.batches);
  await environment.batches.addItem(batchId, {
    action: 'add',
    designName: 'obsolete-validation-icon',
    description: 'Used to create an obsolete validation result.',
  }, Buffer.from(environment.validSvg));
  environment.database.beginValidation(batchId);
  environment.database.completeValidation(batchId, {
    valid: false,
    requestSha256: 'c'.repeat(64),
    errors: [{ code: 'TEST_ERROR', message: 'Needs another edit.' }],
    warnings: [],
  }, 'b'.repeat(40), false);
  assert.equal(environment.batches.getBatch(batchId).validation !== null, true);

  await environment.batches.addItem(batchId, {
    action: 'delete',
    targetName: 'existing',
    reason: 'Editing must invalidate the old result.',
  }, undefined);
  const updated = environment.batches.getBatch(batchId);
  assert.equal(updated.state, 'DRAFT');
  assert.equal(updated.validation, null);
  assert.equal(updated.warningsAcknowledged, false);
  assert.equal(updated.baseCommit, null);
});
