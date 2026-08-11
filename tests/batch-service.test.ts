import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { BatchService } from '../src/batch-service.js';
import { catalogOptionsFromConfig } from '../src/config.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import { BatchStorage, type PublishedClone, type StagedClone } from '../src/storage.js';
import { LocalDiffWorker } from '../src/worker.js';
import type { IconBatchResult } from '../src/types.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

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

class CollidingCloneStorage extends BatchStorage {
  collisionDirectory: string | undefined;
  targetBatchId: string | undefined;

  constructor(private readonly rootPath: string) {
    super(rootPath);
  }

  override async publishStagedClone(staging: StagedClone, targetBatchId: string): Promise<PublishedClone> {
    this.targetBatchId = targetBatchId;
    this.collisionDirectory = join(this.rootPath, targetBatchId);
    await mkdir(this.collisionDirectory, { recursive: true });
    await writeFile(join(this.collisionDirectory, 'pre-existing.txt'), 'do not remove\n');
    return super.publishStagedClone(staging, targetBatchId);
  }
}

class FailingClonePublishStorage extends BatchStorage {
  targetBatchId: string | undefined;

  constructor(
    rootPath: string,
    private readonly beforeFailure: (targetBatchId: string) => void | Promise<void>,
  ) {
    super(rootPath);
  }

  override async publishStagedClone(_staging: StagedClone, targetBatchId: string): Promise<PublishedClone> {
    this.targetBatchId = targetBatchId;
    await this.beforeFailure(targetBatchId);
    throw new Error('Simulated clone publish failure.');
  }
}

class BlockingUpdateStorage extends BatchStorage {
  private armed = false;
  private resolveStarted!: () => void;
  private resolveWrite!: () => void;
  private started = Promise.resolve();
  private write = Promise.resolve();

  arm(): void {
    this.armed = true;
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.write = new Promise<void>((resolve) => {
      this.resolveWrite = resolve;
    });
  }

  override async saveSvg(batchId: string, itemId: string, content: Buffer): Promise<string> {
    const sourceFile = await super.saveSvg(batchId, itemId, content);
    if (this.armed) {
      this.armed = false;
      this.resolveStarted();
      await this.write;
    }
    return sourceFile;
  }

  waitForWrite(): Promise<void> {
    return this.started;
  }

  finishWrite(): void {
    this.resolveWrite();
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

async function createTerminalCloneSource(environment: TestEnvironment, batches = environment.batches) {
  const source = await batches.createBatch({
    title: 'Clone mutation source',
    description: 'A terminal source for clone compensation tests.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await batches.addItem(source.id, {
    action: 'add',
    designName: 'clone-mutation-source-icon',
    description: 'Source SVG for clone compensation tests.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Terminal source fixture.');
  return source;
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
  assert.equal((await batches.submit(batchId)).state, 'QUEUED');
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

  const queued = await environment.batches.submit(batch.id);
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

  const draft = await environment.batches.returnToEdit(batch.id);
  assert.equal(draft.state, 'DRAFT');
  assert.equal(draft.items[0]?.id, item.id);
  assert.equal(draft.items[0]?.sourceFile, item.sourceFile);
  assert.deepEqual(draft.validation, failed.validation);
  assert.equal(draft.userStatus, 'needs_changes');
  assert.equal(draft.plan, null);
  assert.equal(draft.baseCommit, null);
  assert.equal(draft.localDiff, null);
  assert.equal(draft.error, null);
  await assert.rejects(() => environment.batches.submit(batch.id), {
    code: 'REPEATED_SUBMISSION_CONFIRMATION_REQUIRED',
  });
  assert.equal((await environment.batches.submit(batch.id, true)).state, 'QUEUED');
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
  await environment.batches.returnToEdit(batch.id);

  await environment.batches.updateItem(batch.id, item.id, {
    action: 'add',
    designName: 'corrected-final-validation-icon',
    description: 'Changed designer input.',
  }, undefined);
  assert.equal(environment.batches.getBatch(batch.id).validation, null);
  assert.equal(environment.batches.getBatch(batch.id).userStatus, 'draft');
  assert.equal((await environment.batches.submit(batch.id)).state, 'QUEUED');
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
  await assert.rejects(() => environment.batches.returnToEdit(batch.id), { code: 'BATCH_NOT_EDITABLE' });
  await assert.rejects(() => environment.batches.retry(batch.id), { code: 'BATCH_NOT_RETRYABLE' });
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
  assert.equal(Object.hasOwn(cloned, 'nonce'), false);
  assert.equal(Object.hasOwn(cloned, 'cloneCreationNonce'), false);
  assert.equal(cloned.items.length, 1);
  assert.notEqual(cloned.items[0]?.id, item.id);
  assert.notEqual(cloned.items[0]?.sourceFile, item.sourceFile);
  const cloneRequest = JSON.parse(await readFile(await environment.batches.writeRequest(cloned.id), 'utf8')) as { items: Array<{ sourceFile?: string }> };
  assert.match(cloneRequest.items[0]?.sourceFile ?? '', /^uploads\/item-/);
});

test('cloning a terminal batch with a missing source SVG leaves no active batch, items, or clone files', async (t) => {
  const environment = await createTestEnvironment(t);
  const source = await environment.batches.createBatch({
    title: 'Missing clone source',
    description: 'A failed clone must not leave an active DRAFT behind.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  const item = await environment.batches.addItem(source.id, {
    action: 'add',
    designName: 'missing-clone-source-icon',
    description: 'The upload is deliberately removed before cloning.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Terminal source fixture.');
  await rm(join(environment.config.storageRoot, source.id, item.sourceFile!));

  await assert.rejects(() => environment.batches.cloneBatch(source.id));

  assert.equal(environment.batches.getActiveBatch('legacy-bootstrap'), null);
  assert.deepEqual(environment.batches.listBatches(20).map((batch) => batch.id), [source.id]);
  assert.deepEqual(await readdir(environment.config.storageRoot), [source.id]);
});

test('a later source SVG failure cleans staged clone files without changing the old batch', async (t) => {
  const environment = await createTestEnvironment(t);
  const source = await environment.batches.createBatch({
    title: 'Later clone source failure',
    description: 'The first staged SVG must not leave a partial clone.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(source.id, {
    action: 'add',
    designName: 'clone-first-icon',
    description: 'This first source remains readable.',
  }, Buffer.from(environment.validSvg));
  const missing = await environment.batches.addItem(source.id, {
    action: 'add',
    designName: 'clone-second-icon',
    description: 'This second source is removed mid-copy.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Terminal source fixture.');
  await rm(join(environment.config.storageRoot, source.id, missing.sourceFile!));

  await assert.rejects(() => environment.batches.cloneBatch(source.id));

  const retained = environment.batches.getBatch(source.id);
  assert.equal(retained.items.length, 2);
  assert.equal(retained.state, 'FAILED');
  assert.equal(environment.batches.getActiveBatch('legacy-bootstrap'), null);
  assert.deepEqual(await readdir(environment.config.storageRoot), [source.id]);
});

test('a target directory that appears before clone publish is never deleted after rename fails', async (t) => {
  const environment = await createTestEnvironment(t);
  const storage = new CollidingCloneStorage(environment.config.storageRoot);
  const batches = new BatchService(
    environment.database,
    storage,
    environment.batches.repository,
    new IconBatchCli(),
    environment.config.maxUploadBytes,
    catalogOptionsFromConfig(environment.config),
    environment.config.targetRepository,
  );
  const source = await batches.createBatch({
    title: 'Publish collision source',
    description: 'An unrelated target directory must survive a failed rename.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await batches.addItem(source.id, {
    action: 'add',
    designName: 'publish-collision-icon',
    description: 'Source SVG for a clone rename collision.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Terminal source fixture.');

  await assert.rejects(() => batches.cloneBatch(source.id), (error) => {
    assert.ok(storage.collisionDirectory, `clone failed before publish: ${error}`);
    return true;
  });

  assert.ok(storage.collisionDirectory);
  assert.ok(storage.targetBatchId);
  assert.equal(await readFile(join(storage.collisionDirectory, 'pre-existing.txt'), 'utf8'), 'do not remove\n');
  assert.equal(batches.getActiveBatch('legacy-bootstrap'), null);
  assert.deepEqual(batches.listBatches(20).map((batch) => batch.id), [source.id]);
  assert.throws(() => environment.database.getBatch(storage.targetBatchId), { code: 'BATCH_NOT_FOUND' });
  assert.equal(environment.database.getItems(storage.targetBatchId).length, 0);
  assert.equal((await readdir(environment.config.storageRoot)).some((entry) => entry.startsWith('.clone-')), false);
});

test('a same-owner database ID collision never compensates away the existing batch, items, or files', async (t) => {
  const environment = await createTestEnvironment(t);
  const source = await environment.batches.createBatch({
    title: 'Database collision source',
    description: 'An existing same-owner ID must win over clone compensation.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(source.id, {
    action: 'add',
    designName: 'database-collision-source-icon',
    description: 'Source SVG for the attempted clone.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(source.id);
  environment.database.claimNextJob();
  environment.database.failJob(source.id, 'CATALOG_INTEGRITY_MISMATCH', 'Terminal source fixture.');

  const database = environment.database;
  const originalCreate = database.createClonedBatch.bind(database);
  const originalDiscard = database.discardCreatedClone.bind(database);
  let collisionId: string | undefined;
  let discardCalls = 0;
  database.createClonedBatch = ((id, input, catalogBaseline, targetRepository, executionContext, ownerId, items, cloneCreationNonce, enforceSingleActiveOwner) => {
    collisionId = id;
    database.createBatch(id, {
      title: 'Existing same-owner draft',
      description: 'This row was not created by the clone attempt.',
      submitter: input.submitter,
    }, catalogBaseline, targetRepository, executionContext, ownerId, enforceSingleActiveOwner);
    database.insertItem(id, 'item-existing-collision', {
      action: 'add',
      designName: 'existing-collision-icon',
      description: 'Keep the existing item intact.',
    }, 'uploads/item-existing-collision.svg');
    mkdirSync(join(environment.config.storageRoot, id, 'uploads'), { recursive: true });
    writeFileSync(join(environment.config.storageRoot, id, 'uploads/item-existing-collision.svg'), 'existing clone collision file\n');
    return originalCreate(id, input, catalogBaseline, targetRepository, executionContext, ownerId, items, cloneCreationNonce, enforceSingleActiveOwner);
  }) as typeof database.createClonedBatch;
  database.discardCreatedClone = ((created) => {
    discardCalls += 1;
    return originalDiscard(created);
  }) as typeof database.discardCreatedClone;
  t.after(() => {
    database.createClonedBatch = originalCreate;
    database.discardCreatedClone = originalDiscard;
  });

  await assert.rejects(() => environment.batches.cloneBatch(source.id));

  assert.ok(collisionId);
  assert.equal(discardCalls, 0);
  const existing = database.getDetails(collisionId);
  assert.equal(existing.title, 'Existing same-owner draft');
  assert.deepEqual(existing.items.map((item) => item.id), ['item-existing-collision']);
  assert.equal(await readFile(join(environment.config.storageRoot, collisionId, 'uploads/item-existing-collision.svg'), 'utf8'), 'existing clone collision file\n');
});

test('a clone ownership nonce survives SQLite rowid reuse and cannot delete a later same-owner row', async (t) => {
  const environment = await createTestEnvironment(t);
  const input = {
    title: 'Clone handle fixture',
    description: 'Database row identity must survive sequential ID reuse.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  };
  const catalogBaseline = {
    packageName: '@pink/codicons', requestedTag: 'beta', version: '0.0.46-test.1', integrity: 'sha512-test',
    sourceRepository: 'sud-global/pink-codicons', sourceCommit: 'a'.repeat(40),
  };
  const targetRepository = { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' as const };
  const executionContext = { executionMode: 'local' as const, pushRepository: null, pushBranchPrefix: null };
  const batchId = 'ICON-20260811-C0FFEE00';
  const created = environment.database.createClonedBatch(
    batchId, input, catalogBaseline, targetRepository, executionContext, 'legacy-bootstrap', [], 'clone-nonce-old', false,
  );
  const before = new Database(environment.config.databasePath, { readonly: true });
  const oldRow = before.prepare('SELECT rowid FROM batches WHERE id = ?').get(batchId) as { rowid: number };
  before.close();
  environment.database.discardCreatedClone(created);

  environment.database.createBatch(batchId, {
    ...input,
    title: 'Later same-owner row',
  }, catalogBaseline, targetRepository, executionContext);
  const after = new Database(environment.config.databasePath, { readonly: true });
  const laterRow = after.prepare('SELECT rowid, clone_creation_nonce FROM batches WHERE id = ?').get(batchId) as { rowid: number; clone_creation_nonce: string | null };
  after.close();

  assert.equal(laterRow.rowid, oldRow.rowid, 'the SQLite rowid was reused');
  assert.equal(laterRow.clone_creation_nonce, null);
  assert.throws(() => environment.database.discardCreatedClone(created), { code: 'CLONE_CLEANUP_CONFLICT' });
  assert.equal(environment.database.getBatch(batchId).title, 'Later same-owner row');
});

test('a completed clone publication retires its compensation handle', async (t) => {
  const environment = await createTestEnvironment(t);
  const input = {
    title: 'Clone completion fixture',
    description: 'A completed clone cannot be discarded by its old handle.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  };
  const catalogBaseline = {
    packageName: '@pink/codicons', requestedTag: 'beta', version: '0.0.46-test.1', integrity: 'sha512-test',
    sourceRepository: 'sud-global/pink-codicons', sourceCommit: 'a'.repeat(40),
  };
  const targetRepository = { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' as const };
  const executionContext = { executionMode: 'local' as const, pushRepository: null, pushBranchPrefix: null };
  const created = environment.database.createClonedBatch(
    'ICON-20260811-C0FFEE01', input, catalogBaseline, targetRepository, executionContext, 'legacy-bootstrap', [], 'clone-nonce-complete', false,
  );

  environment.database.completeClonePublication(created);

  assert.throws(() => environment.database.discardCreatedClone(created), { code: 'CLONE_CLEANUP_CONFLICT' });
  assert.equal(environment.database.getBatch(created.id).state, 'DRAFT');
});

for (const scenario of [
  {
    name: 'metadata edit',
    mutate: (environment: TestEnvironment, _batches: BatchService, batchId: string) => {
      environment.database.updateBatchMetadata(batchId, {
        title: 'Edited while clone publish is failing',
        description: 'The compensation handle must no longer own this batch.',
      });
    },
    expectedState: 'DRAFT',
  },
  {
    name: 'item edit',
    mutate: (environment: TestEnvironment, _batches: BatchService, batchId: string) => {
      const item = environment.database.getDetails(batchId).items[0]!;
      environment.database.updateItem(batchId, item.id, {
        action: 'add',
        designName: 'edited-clone-item',
        description: 'An item edit invalidates clone compensation ownership.',
      }, item.sourceFile);
    },
    expectedState: 'DRAFT',
  },
  {
    name: 'item add',
    mutate: (environment: TestEnvironment, _batches: BatchService, batchId: string) => {
      environment.database.insertItem(batchId, 'item-added-during-clone-failure', {
        action: 'add',
        designName: 'added-clone-item',
        description: 'An added item invalidates clone compensation ownership.',
      }, null);
    },
    expectedState: 'DRAFT',
  },
  {
    name: 'item delete',
    mutate: (environment: TestEnvironment, _batches: BatchService, batchId: string) => {
      const item = environment.database.getDetails(batchId).items[0]!;
      environment.database.deleteItem(batchId, item.id);
    },
    expectedState: 'DRAFT',
  },
  {
    name: 'submit',
    mutate: async (_environment: TestEnvironment, batches: BatchService, batchId: string) => {
      await batches.submit(batchId);
    },
    expectedState: 'QUEUED',
  },
] as const) {
  test(`a clone publish failure never compensates away a batch changed by ${scenario.name}`, async (t) => {
    const environment = await createTestEnvironment(t);
    let batches!: BatchService;
    const storage = new FailingClonePublishStorage(environment.config.storageRoot, (batchId) => {
      return scenario.mutate(environment, batches, batchId);
    });
    batches = new BatchService(
      environment.database,
      storage,
      environment.batches.repository,
      new IconBatchCli(),
      environment.config.maxUploadBytes,
      catalogOptionsFromConfig(environment.config),
      environment.config.targetRepository,
    );
    const source = await createTerminalCloneSource(environment, batches);

    await assert.rejects(() => batches.cloneBatch(source.id));

    assert.ok(storage.targetBatchId);
    const retained = environment.database.getDetails(storage.targetBatchId);
    assert.equal(retained.state, scenario.expectedState);
    if (scenario.name === 'submit') {
      assert.equal(retained.job?.state, 'QUEUED');
    } else {
      assert.equal(retained.job, null);
    }
    assert.equal((await readdir(environment.config.storageRoot)).some((entry) => entry.startsWith('.clone-')), false);
  });
}

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

  await environment.batches.returnToEdit(batch.id);
  await assert.rejects(() => environment.batches.submit(batch.id), {
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
  await environment.batches.submit((await environment.batches.validateBatch(batchId)).id);
  assert.equal(environment.database.claimNextJob()?.state, 'RUNNING');

  assert.equal(environment.database.recoverInterruptedJobs(), 1);
  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'WORKER_INTERRUPTED');
  assert.equal(failed.job?.state, 'FAILED');
  assert.deepEqual(failed.failureHistory.map((failure) => ({ attempt: failure.attempt, code: failure.code })), [
    { attempt: 1, code: 'WORKER_INTERRUPTED' },
  ]);

  const retried = await environment.batches.retry(batchId);
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

  const retried = await environment.batches.retry(batchId);
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

test('submit waits for an in-flight SVG update on the same batch', async (t) => {
  const environment = await createTestEnvironment(t);
  const storage = new BlockingUpdateStorage(environment.config.storageRoot);
  const batches = new BatchService(
    environment.database,
    storage,
    environment.batches.repository,
    environment.batches.iconBatch,
    environment.config.maxUploadBytes,
    catalogOptionsFromConfig(environment.config),
    environment.config.targetRepository,
  );
  const batchId = await createBatch(batches);
  const item = await batches.addItem(batchId, {
    action: 'add',
    designName: 'serialized-update-icon',
    description: 'Original description',
  }, Buffer.from(environment.validSvg));
  storage.arm();

  const update = batches.updateItem(batchId, item.id, {
    action: 'add',
    designName: 'serialized-update-icon',
    description: 'Updated description',
  }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h1v1H2z"/></svg>'));
  await storage.waitForWrite();
  const submit = batches.submit(batchId);

  await Promise.resolve();
  assert.equal(environment.database.getBatch(batchId).state, 'DRAFT');
  storage.finishWrite();
  await update;
  assert.equal((await submit).state, 'QUEUED');
  assert.equal(environment.database.getItem(batchId, item.id).description, 'Updated description');
});
