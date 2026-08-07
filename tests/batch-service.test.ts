import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

class CapturingIconBatchCli extends IconBatchCli {
  readonly requests: Array<{ request: Record<string, unknown>; svg: string }> = [];

  override async validate(_worktreePath: string, requestPath: string): Promise<IconBatchResult> {
    const request = JSON.parse(await readFile(requestPath, 'utf8')) as Record<string, unknown>;
    const items = request.items as Array<{ sourceFile?: string }>;
    const svg = await readFile(join(dirname(requestPath), items[0]!.sourceFile!), 'utf8');
    this.requests.push({ request, svg });
    const valid = this.requests.length > 1;
    return {
      exitCode: 0,
      payload: {
        schemaVersion: 2,
        valid,
        requestSha256: valid ? 'b'.repeat(64) : 'a'.repeat(64),
        baseCommit: 'c'.repeat(40),
        summary: { errorCount: valid ? 0 : 1, warningCount: 0 },
        errors: valid ? [] : [{ code: 'TEST_INVALID', message: 'Simulated first validation failure.' }],
        warnings: [],
      },
    };
  }
}

async function createBatch(batches: BatchService): Promise<string> {
  return (await batches.createBatch({
    title: 'State test',
    description: 'State transition test',
    designUrl: 'https://design.example.invalid/state-test',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  })).id;
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
    environment.config.targetRepository,
  );
  const batchId = await createBatch(batches);
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
  const batchId = await createBatch(environment.batches);
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
  assert.deepEqual(failed.failureHistory.map((failure) => ({ attempt: failure.attempt, code: failure.code })), [
    { attempt: 1, code: 'WORKER_INTERRUPTED' },
  ]);

  const retried = environment.batches.retry(batchId);
  assert.equal(retried.state, 'QUEUED');
  assert.equal(retried.job?.state, 'QUEUED');
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.failureHistory.length, 1);
});

test('interrupted VALIDATING batches return to DRAFT on startup recovery', async (t) => {
  const environment = await createTestEnvironment(t);
  const batchId = await createBatch(environment.batches);
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
  const batchId = await createBatch(environment.batches);
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

test('editing DRAFT batch metadata clears validation and the next validation uses the latest metadata and SVG', async (t) => {
  const environment = await createTestEnvironment(t);
  const iconBatch = new CapturingIconBatchCli();
  const batches = new BatchService(
    environment.database,
    environment.batches.storage,
    environment.batches.repository,
    iconBatch,
    environment.config.maxUploadBytes,
    catalogOptionsFromConfig(environment.config),
    environment.config.targetRepository,
  );
  const batchId = await createBatch(batches);
  const item = await batches.addItem(batchId, {
    action: 'add',
    designName: 'metadata-recheck-icon',
    description: 'Original description',
  }, Buffer.from(environment.validSvg));

  const first = await batches.validateBatch(batchId);
  assert.equal(first.state, 'DRAFT');
  assert.equal(first.validation !== null, true);

  const updated = await batches.updateBatch(batchId, {
    title: 'Updated metadata title',
    description: 'Updated metadata description',
    designUrl: 'https://design.example.invalid/updated',
  });
  assert.equal(updated.validation, null);
  assert.equal(updated.warningsAcknowledged, false);
  assert.equal(updated.baseCommit, null);

  const updatedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h1v1H1z"/></svg>';
  await batches.updateItem(batchId, item.id, {
    action: 'add',
    designName: 'metadata-recheck-icon',
    description: 'Updated item description',
  }, Buffer.from(updatedSvg));
  const second = await batches.validateBatch(batchId);
  assert.equal(second.state, 'READY');
  assert.equal(iconBatch.requests.length, 2);
  assert.deepEqual(iconBatch.requests[1]?.request.title, 'Updated metadata title');
  assert.deepEqual(iconBatch.requests[1]?.request.description, 'Updated metadata description');
  assert.deepEqual(iconBatch.requests[1]?.request.designUrl, 'https://design.example.invalid/updated');
  assert.equal(iconBatch.requests[1]?.svg, updatedSvg);
});
