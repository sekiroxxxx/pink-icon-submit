import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { BatchService } from '../src/batch-service.js';
import { catalogOptionsFromConfig } from '../src/config.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import { LocalDiffWorker } from '../src/worker.js';
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

test('DRAFT submission validates only local input requirements and does not require compatibility validation', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Queue from draft',
    description: 'Final validation belongs to the Worker.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'draft-queue-icon',
    description: 'Queues without a compatibility validation request.',
  }, Buffer.from(environment.validSvg));

  const queued = environment.batches.submit(batch.id);
  assert.equal(queued.state, 'QUEUED');
  assert.equal(queued.validation, null);
  assert.equal(queued.designUrl, undefined);

  const requestPath = await environment.batches.writeRequest(batch.id);
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(request, 'designUrl'), false);
});

test('a final validation failure at checkpoint NONE returns to editing and requires confirmation only when unchanged', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Correct final validation',
    description: 'Preserve the designer input after a business failure.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const item = await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'final-validation-failure',
    description: 'Fails only in final Stage 1 validation.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);
  await new LocalDiffWorker(environment.batches).processNext();
  const failed = environment.batches.getBatch(batch.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'NONE');
  assert.equal(failed.validation !== null, true);

  const draft = environment.batches.returnToEdit(batch.id);
  assert.equal(draft.state, 'DRAFT');
  assert.equal(draft.items[0]?.id, item.id);
  assert.equal(draft.items[0]?.sourceFile, item.sourceFile);
  assert.deepEqual(draft.validation, failed.validation);
  assert.equal(draft.userStatus, 'needs_changes');
  assert.equal(draft.plan, null);
  assert.equal(draft.baseCommit, null);
  assert.equal(draft.localDiff, null);
  assert.equal(draft.error, null);
  assert.throws(() => environment.batches.submit(batch.id), {
    code: 'REPEATED_SUBMISSION_CONFIRMATION_REQUIRED',
  });
  assert.equal(environment.batches.submit(batch.id, true).state, 'QUEUED');
});

test('editing after a final validation failure permits a normal DRAFT resubmission', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Edit after final validation',
    description: 'A real edit removes the unchanged resubmission confirmation.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const item = await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'final-validation-failure',
    description: 'Will be corrected before resubmission.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);
  await new LocalDiffWorker(environment.batches).processNext();
  environment.batches.returnToEdit(batch.id);

  await environment.batches.updateItem(batch.id, item.id, {
    action: 'add',
    designName: 'corrected-final-validation-icon',
    description: 'Changed designer input.',
  }, undefined);
  assert.equal(environment.batches.getBatch(batch.id).validation, null);
  assert.equal(environment.batches.getBatch(batch.id).userStatus, 'draft');
  assert.equal(environment.batches.submit(batch.id).state, 'QUEUED');
});

test('a system final validation diagnostic requires developer handling instead of designer retry or return-to-edit', async (t) => {
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'System final validation failure',
    description: 'Repository mapping diagnostics are not designer-editable.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'mapping-diagnostic-icon',
    description: 'Keeps a source SVG for the persisted failure.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);
  environment.database.claimNextJob();
  environment.database.recordFinalValidation(batch.id, {
    valid: false,
    requestSha256: 'a'.repeat(64),
    errors: [{ code: 'MAPPING_SOURCE_INVALID', message: 'Target mapping is invalid.' }],
    warnings: [],
  }, 'b'.repeat(40));
  environment.database.failJob(batch.id, 'FINAL_VALIDATION_FAILED', 'Target mapping is invalid.');

  const failed = environment.batches.getBatch(batch.id);
  assert.equal(failed.userStatus, 'developer_attention');
  assert.throws(() => environment.batches.returnToEdit(batch.id), { code: 'BATCH_NOT_EDITABLE' });
  assert.throws(() => environment.batches.retry(batch.id), { code: 'BATCH_NOT_RETRYABLE' });
});

test('cloning an immutable batch copies designer content without delivery or validation evidence', async (t) => {
  const environment = await createTestEnvironment(t);
  const source = await environment.batches.createBatch({
    title: 'Copy terminal design',
    description: 'Copies designer-visible metadata and uploaded SVG only.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const item = await environment.batches.addItem(source.id, {
    action: 'add',
    designName: 'copy-terminal-icon',
    description: 'Source item that will be copied.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Catalog integrity failure.');

  const cloned = await environment.batches.cloneBatch(source.id);
  assert.notEqual(cloned.id, source.id);
  assert.equal(cloned.state, 'DRAFT');
  assert.equal(cloned.userStatus, 'draft');
  assert.equal(cloned.validation, null);
  assert.equal(cloned.error, null);
  assert.equal(cloned.plan, null);
  assert.equal(cloned.baseCommit, null);
  assert.equal(cloned.localDiff, null);
  assert.equal(cloned.delivery.checkpoint, 'NONE');
  assert.equal(cloned.job, null);
  assert.equal(cloned.items.length, 1);
  assert.notEqual(cloned.items[0]?.id, item.id);
  assert.notEqual(cloned.items[0]?.sourceFile, item.sourceFile);
  const cloneRequest = JSON.parse(await readFile(await environment.batches.writeRequest(cloned.id), 'utf8')) as { items: Array<{ sourceFile?: string }> };
  assert.match(cloneRequest.items[0]?.sourceFile ?? '', /^uploads\/item-/);
});

test('DRAFT content edits advance a monotonic revision after a same-millisecond final validation failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-10T08:00:00.000Z') });
  const environment = await createTestEnvironment(t);
  const batch = await environment.batches.createBatch({
    title: 'Monotonic content revision',
    description: 'Every real DRAFT edit must differ from the failure snapshot.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const firstItem = await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'revision-first-icon',
    description: 'Existing item for the final validation failure.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);
  environment.database.claimNextJob();
  environment.database.recordFinalValidation(batch.id, {
    valid: false,
    requestSha256: 'a'.repeat(64),
    errors: [{ code: 'SVG_MULTIPLE_COLORS', message: 'Simulated final validation failure.' }],
    warnings: [],
  }, 'b'.repeat(40));
  environment.database.failJob(batch.id, 'FINAL_VALIDATION_FAILED', 'Simulated final validation failure.');
  const failure = environment.batches.getBatch(batch.id).failureHistory.at(-1)!;

  environment.batches.returnToEdit(batch.id);
  assert.throws(() => environment.batches.submit(batch.id), {
    code: 'REPEATED_SUBMISSION_CONFIRMATION_REQUIRED',
  });

  const editedMetadata = await environment.batches.updateBatch(batch.id, {
    title: 'Updated monotonic content revision',
    description: 'Metadata is the first edit in the same wall-clock millisecond.',
  });
  assert.ok(Date.parse(editedMetadata.updatedAt) > Date.parse(failure.createdAt));
  assert.equal(environment.database.requiresRepeatedSubmissionConfirmation(batch.id), false);

  const secondItem = await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'revision-second-icon',
    description: 'Adding an item must advance the same revision cursor.',
  }, Buffer.from(environment.validSvg));
  const afterAdd = environment.batches.getBatch(batch.id);
  assert.ok(Date.parse(afterAdd.updatedAt) > Date.parse(editedMetadata.updatedAt));

  await environment.batches.updateItem(batch.id, firstItem.id, {
    action: 'add',
    designName: 'revision-first-icon-corrected',
    description: 'Updating an item must advance the same revision cursor.',
  }, undefined);
  const afterUpdate = environment.batches.getBatch(batch.id);
  assert.ok(Date.parse(afterUpdate.updatedAt) > Date.parse(afterAdd.updatedAt));

  await environment.batches.deleteItem(batch.id, secondItem.id);
  const afterDelete = environment.batches.getBatch(batch.id);
  assert.ok(Date.parse(afterDelete.updatedAt) > Date.parse(afterUpdate.updatedAt));
  assert.equal(environment.database.requiresRepeatedSubmissionConfirmation(batch.id), false);
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

test('a checkpoint NONE infrastructure failure remains manually retryable without a validation result', async (t) => {
  const environment = await createTestEnvironment(t);
  const batchId = await createBatch(environment.batches);
  await environment.batches.addItem(batchId, {
    action: 'add',
    designName: 'retry-infrastructure-icon',
    description: 'Infrastructure failures can be retried manually.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batchId);
  environment.database.claimNextJob();
  environment.database.failJob(batchId, 'GIT_COMMAND_FAILED', 'Temporary target fetch failure.', {
    operation: 'git fetch',
    command: 'git fetch upstream',
    exitCode: 128,
    stderr: 'temporary failure',
  });

  const retried = environment.batches.retry(batchId);
  assert.equal(retried.state, 'QUEUED');
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.validation, null);
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
