import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { AuthService, sessionCookieName } from '../src/auth.js';
import { createTestEnvironment } from './helpers.js';

async function buildAuthenticatedApp(environment: Awaited<ReturnType<typeof createTestEnvironment>>) {
  const auth = new AuthService(environment.database);
  await auth.provisionBootstrapUser({ username: 'designer@example.invalid', password: 'test-password' });
  const session = await auth.login({ username: 'designer@example.invalid', password: 'test-password' });
  const app = await buildApp({ batches: environment.batches, auth });
  app.addHook('onRequest', async (request) => {
    if (!request.headers.cookie) request.headers.cookie = `${sessionCookieName}=${session.token}`;
  });
  return { app, user: session.user };
}

test('batch API stores uploads, validates through icon-batch, and exposes catalog', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Add icon',
      description: 'Test batch',
      designUrl: 'https://design.example.invalid/icon',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  assert.equal(created.statusCode, 201);
  const batch = created.json() as { id: string };

  const boundary = '----pink-icon-submit-test';
  const multipartPayload = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="item"',
    '',
    JSON.stringify({ action: 'add', designName: 'api-icon', description: 'API icon', clientMutationId: 'mutation-api-icon-0001' }),
    `--${boundary}`,
    'Content-Disposition: form-data; name="svg"; filename="api-icon.svg"',
    'Content-Type: image/svg+xml',
    '',
    environment.validSvg,
    `--${boundary}--`,
    '',
  ].join('\r\n'));
  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${batch.id}/items`,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartPayload,
  });
  assert.equal(item.statusCode, 201);

  const validated = await app.inject({ method: 'POST', url: `/api/batches/${batch.id}/validate` });
  assert.equal(validated.statusCode, 200);
  assert.equal((validated.json() as { state: string }).state, 'READY');

  const catalog = await app.inject({ method: 'GET', url: '/api/catalog' });
  assert.equal(catalog.statusCode, 200);
  assert.equal((catalog.json() as { schemaVersion: number }).schemaVersion, 1);

  const preview = await app.inject({ method: 'GET', url: '/api/catalog/icons/existing/svg' });
  assert.equal(preview.statusCode, 200);
  assert.match(preview.headers['content-type'] ?? '', /^image\/svg\+xml/);
  assert.equal(preview.body, environment.validSvg);
});

test('DRAFT items can be updated and deleted', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Edit item',
      description: 'Tests DRAFT item editing',
      designUrl: 'https://design.example.invalid/edit-item',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'add',
      clientMutationId: 'mutation-editable-icon-0001',
      designName: 'editable-icon',
      description: 'Original description',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);
  const itemId = (item.json() as { id: string }).id;

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/batches/${batchId}/items/${itemId}`,
    payload: {
      action: 'add',
      designName: 'editable-icon',
      description: 'Updated description',
    },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal((updated.json() as { description: string }).description, 'Updated description');

  const removed = await app.inject({ method: 'DELETE', url: `/api/batches/${batchId}/items/${itemId}` });
  assert.equal(removed.statusCode, 204);
  const batch = await app.inject({ method: 'GET', url: `/api/batches/${batchId}` });
  assert.deepEqual((batch.json() as { items: unknown[] }).items, []);
});

test('item creation is idempotent for a stable client mutation id and rejects mismatched replays', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Idempotent item creation',
      description: 'Repeated browser delivery must create one item.',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const payload = {
    action: 'add',
    designName: 'idempotent-api-icon',
    description: 'Stable browser mutation identity.',
    clientMutationId: 'mutation-idempotent-api-0001',
    svgBase64: Buffer.from(environment.validSvg).toString('base64'),
  };
  const [first, second] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/batches/${batchId}/items`, payload }),
    app.inject({ method: 'POST', url: `/api/batches/${batchId}/items`, payload }),
  ]);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal((first.json() as { id: string }).id, (second.json() as { id: string }).id);
  assert.equal(environment.database.countItems(batchId), 1);

  const conflict = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: { ...payload, description: 'A different request must not overwrite the original.' },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.json() as { error: { code: string } }).error.code, 'ITEM_MUTATION_CONFLICT');
  assert.equal(environment.database.countItems(batchId), 1);
});

test('item creation requires a stable client mutation id', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Mutation identity required',
      description: 'A client cannot opt out of idempotent item creation.',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const response = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'add',
      designName: 'missing-mutation-id',
      description: 'This request has no client mutation id.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');
  assert.equal(environment.database.countItems(batchId), 0);
});

test('DRAFT batch metadata can be updated and clears obsolete validation, but READY batches remain immutable', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Original title',
      description: 'Original description',
      designUrl: 'https://design.example.invalid/original',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  environment.database.beginValidation(batchId);
  environment.database.completeValidation(batchId, {
    valid: false,
    requestSha256: 'd'.repeat(64),
    errors: [{ code: 'TEST_ERROR', message: 'Old validation result.' }],
    warnings: [],
  }, 'e'.repeat(40), false);

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/batches/${batchId}`,
    payload: {
      title: 'Updated title',
      description: 'Updated description',
      designUrl: 'https://design.example.invalid/updated',
    },
  });
  assert.equal(updated.statusCode, 200);
  const updatedBody = updated.json() as {
    state: string;
    title: string;
    description: string;
    designUrl: string;
    validation: unknown;
    warningsAcknowledged: boolean;
    baseCommit: string | null;
    localDiff: unknown;
  };
  assert.equal(updatedBody.state, 'DRAFT');
  assert.equal(updatedBody.title, 'Updated title');
  assert.equal(updatedBody.description, 'Updated description');
  assert.equal(updatedBody.designUrl, 'https://design.example.invalid/updated');
  assert.equal(updatedBody.validation, null);
  assert.equal(updatedBody.warningsAcknowledged, false);
  assert.equal(updatedBody.baseCommit, null);
  assert.equal(updatedBody.localDiff, null);

  const validated = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/validate` });
  assert.equal(validated.statusCode, 409);
  assert.equal((validated.json() as { error: { code: string } }).error.code, 'BATCH_EMPTY');

  await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'add',
      clientMutationId: 'mutation-ready-metadata-0001',
      designName: 'ready-metadata-icon',
      description: 'Makes the batch valid.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  const validation = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/validate` });
  assert.equal(validation.statusCode, 200);

  const rejected = await app.inject({
    method: 'PUT',
    url: `/api/batches/${batchId}`,
    payload: {
      title: 'Not allowed',
      description: 'Not allowed',
      designUrl: 'https://design.example.invalid/not-allowed',
    },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal((rejected.json() as { error: { code: string } }).error.code, 'BATCH_NOT_EDITABLE');
});

test('delete replacement must select a different existing catalog icon', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Delete replacement',
      description: 'Rejects same-icon replacement.',
      designUrl: 'https://design.example.invalid/delete',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const response = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'delete',
      clientMutationId: 'mutation-delete-replacement-0001',
      targetName: 'existing',
      replacementName: 'existing-alias',
      reason: 'Must use a different icon.',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'ITEM_INVALID');
});

test('catalog page returns canonical icons with SVG thumbnails and normalizes aliases', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const page = await app.inject({ method: 'GET', url: '/api/catalog/page?query=existing&group=common&page=1&pageSize=24' });
  assert.equal(page.statusCode, 200);
  const response = page.json() as {
    catalogBaseline: { packageName: string; requestedTag: string; version: string; sourceCommit: string };
    page: number;
    pageSize: number;
    total: number;
    icons: Array<{ primaryName: string; aliases: string[]; group: string; svg: string }>;
  };
  assert.equal(response.catalogBaseline.packageName, '@pink/codicons');
  assert.equal(response.catalogBaseline.requestedTag, 'beta');
  assert.equal(response.catalogBaseline.version, '0.0.46-test.1');
  assert.equal(response.catalogBaseline.sourceCommit, 'f'.repeat(40));
  assert.equal(response.page, 1);
  assert.equal(response.pageSize, 24);
  assert.equal(response.total, 1);
  assert.deepEqual(response.icons, [{
    primaryName: 'existing',
    aliases: ['existing', 'existing-alias'],
    group: 'common',
    svg: environment.validSvg,
  }]);

  const invalidPage = await app.inject({ method: 'GET', url: '/api/catalog/page?group=unknown' });
  assert.equal(invalidPage.statusCode, 400);
  assert.equal((invalidPage.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Replace icon',
      description: 'Canonical target name test',
      designUrl: 'https://design.example.invalid/replace',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'replace',
      clientMutationId: 'mutation-replace-icon-0001',
      targetName: 'existing-alias',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);
  assert.equal((item.json() as { targetName: string }).targetName, 'existing');
});

test('name preview delegates normalization and catalog collision checks to icon-batch', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const preview = await app.inject({ method: 'GET', url: '/api/names/preview?name=ExistingAlias' });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json(), {
    schemaVersion: 1,
    baseCommit: preview.json().baseCommit,
    input: 'ExistingAlias',
    normalizedName: 'existing-alias',
    valid: true,
    collision: { primaryName: 'existing', aliases: ['existing-alias'] },
  });

  const missing = await app.inject({ method: 'GET', url: '/api/names/preview' });
  assert.equal(missing.statusCode, 400);
  assert.equal((missing.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');

  const invalid = await app.inject({ method: 'GET', url: '/api/names/preview?name=---' });
  assert.equal(invalid.statusCode, 200);
  assert.deepEqual(invalid.json(), {
    schemaVersion: 1,
    baseCommit: invalid.json().baseCommit,
    input: '---',
    normalizedName: '',
    valid: false,
    collision: null,
  });
});

test('validation warnings are retained for developer review without blocking submission', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Warning acknowledgement',
      description: 'Ensures warnings are acknowledged.',
      designUrl: 'https://design.example.invalid/warnings',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    payload: {
      action: 'add',
      clientMutationId: 'mutation-warning-icon-0001',
      designName: 'warning-icon',
      description: 'Triggers a test warning.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);
  const validated = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/validate` });
  assert.equal(validated.statusCode, 200);
  const queued = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/submit` });
  assert.equal(queued.statusCode, 200);
  assert.equal((queued.json() as { state: string }).state, 'QUEUED');
});

test('catalog pages reuse the immutable npm snapshot across repeated reads', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const first = await app.inject({ method: 'GET', url: '/api/catalog/page?page=1&pageSize=24' });
  const second = await app.inject({ method: 'GET', url: '/api/catalog/page?query=existing&page=1&pageSize=24' });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(environment.registryRequests, { metadata: 1, tarball: 1 });

  const refreshed = await app.inject({ method: 'GET', url: '/api/catalog/page?page=1&pageSize=24' });
  assert.equal(refreshed.statusCode, 200);
  assert.deepEqual(refreshed.json().catalogBaseline, first.json().catalogBaseline);
  assert.deepEqual(environment.registryRequests, { metadata: 1, tarball: 1 });
});

test('batch creation derives the submitter from the authenticated account and rejects invalid design links', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const invalidUrl = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Invalid link',
      description: 'Validation',
      designUrl: 'ftp://design.example.invalid/link',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  assert.equal(invalidUrl.statusCode, 400);
  assert.equal((invalidUrl.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');

  const malformedHttps = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Malformed HTTPS link',
      description: 'Validation',
      designUrl: 'https:www.123.com',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  assert.equal(malformedHttps.statusCode, 400);
  assert.equal((malformedHttps.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');

  const spoofedSubmitter = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Authenticated submitter',
      description: 'The account identity must override request-provided submitter data.',
      submitter: { name: 'Spoofed', email: 'spoofed@example.invalid' },
    },
  });
  assert.equal(spoofedSubmitter.statusCode, 201);
  assert.deepEqual((spoofedSubmitter.json() as { submitter: unknown }).submitter, {
    name: 'designer',
    email: 'designer@example.invalid',
  });
});

test('oversized multipart SVG returns UPLOAD_TOO_LARGE', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const boundary = '----pink-icon-submit-oversized';
  const payload = Buffer.concat([
    Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="svg"; filename="too-large.svg"',
      'Content-Type: image/svg+xml',
      '',
    ].join('\r\n') + '\r\n'),
    Buffer.alloc(environment.config.maxUploadBytes + 1, 0x61),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/api/batches/not-needed/items',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: {
      code: 'UPLOAD_TOO_LARGE',
      message: `SVG upload exceeds ${environment.config.maxUploadBytes} bytes.`,
    },
  });
});

test('multipart item payload must be an object', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Malformed item',
      description: 'Reject malformed multipart JSON',
      designUrl: 'https://design.example.invalid/malformed-item',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  const batchId = (created.json() as { id: string }).id;
  const boundary = '----pink-icon-submit-malformed';
  const response = await app.inject({
    method: 'POST',
    url: `/api/batches/${batchId}/items`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="item"',
      '',
      '[]',
      `--${boundary}--`,
      '',
    ].join('\r\n')),
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'ITEM_INVALID');
});

test('DRAFT API delivery accepts an optional design link and queues without the legacy validate endpoint', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Optional design link',
      description: 'Worker validation will run after review submission.',
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as { id: string; designUrl?: string };
  assert.equal(body.designUrl, undefined);

  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${body.id}/items`,
    payload: {
      action: 'add',
      clientMutationId: 'mutation-optional-design-0001',
      designName: 'optional-design-link-icon',
      description: 'Can be queued without an interactive validation result.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);

  const queued = await app.inject({ method: 'POST', url: `/api/batches/${body.id}/submit` });
  assert.equal(queued.statusCode, 200);
  assert.equal((queued.json() as { state: string; validation: unknown }).state, 'QUEUED');
  assert.equal((queued.json() as { validation: unknown }).validation, null);
});

test('batch list returns user-only summaries with stable bounds, ordering, and recovery status', async (t) => {
  const environment = await createTestEnvironment(t);
  const { app, user } = await buildAuthenticatedApp(environment);
  t.after(() => app.close());

  const seed = await environment.batches.createBatch({
    title: 'Seed batch',
    description: 'Supplies the frozen protocol context for direct fixture rows.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  }, user.id);
  const localContext = {
    executionMode: seed.executionMode ?? 'local' as const,
    pushRepository: seed.pushRepository,
    pushBranchPrefix: seed.pushBranchPrefix,
  };
  const create = (id: string, title: string, context = localContext) => environment.database.createBatch(id, {
    title,
    description: `${title} description`,
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  }, seed.catalogBaseline!, seed.targetRepository!, context, user.id);
  for (let index = 0; index < 21; index += 1) {
    create(`ICON-HOME-${String(index).padStart(2, '0')}`, `Batch ${index}`);
  }

  const remoteContext = {
    executionMode: 'remote' as const,
    pushRepository: 'sud-icon-bot/example-icon-repository',
    pushBranchPrefix: 'bot/',
  };
  create('ICON-HOME-Z-RETRY', 'Recoverable Draft PR', remoteContext);
  environment.database.insertItem('ICON-HOME-Z-RETRY', 'item-add', {
    action: 'add', designName: 'summary-add', description: 'An added icon.',
  }, 'items/item-add.svg');
  environment.database.insertItem('ICON-HOME-Z-RETRY', 'item-replace', {
    action: 'replace', targetName: 'existing', description: 'A replacement.',
  }, 'items/item-replace.svg');
  environment.database.insertItem('ICON-HOME-Z-RETRY', 'item-delete', {
    action: 'delete', targetName: 'retired', reason: 'No longer needed.',
  }, null);
  environment.database.queueJob('ICON-HOME-Z-RETRY');
  environment.database.claimNextJob();
  environment.database.recordCommitPrepared('ICON-HOME-Z-RETRY', { items: [] }, 'a'.repeat(40), { changedFiles: [] }, 'bot/ICON-HOME-Z-RETRY', 'b'.repeat(40));
  environment.database.recordBranchPushed('ICON-HOME-Z-RETRY');
  environment.database.failJob('ICON-HOME-Z-RETRY', 'GIT_COMMAND_FAILED', 'Internal command and diagnostics must not appear in a summary.');

  create('ICON-HOME-Z-MISSING', 'Incomplete Draft PR evidence', remoteContext);
  environment.database.queueJob('ICON-HOME-Z-MISSING');
  environment.database.claimNextJob();
  environment.database.recordCommitPrepared('ICON-HOME-Z-MISSING', { items: [] }, 'c'.repeat(40), { changedFiles: [] }, 'bot/ICON-HOME-Z-MISSING', 'd'.repeat(40));
  environment.database.recordBranchPushed('ICON-HOME-Z-MISSING');
  environment.database.failJob('ICON-HOME-Z-MISSING', 'GIT_COMMAND_FAILED', 'Missing persisted base must require developer handling.');
  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare('UPDATE batches SET base_commit = NULL WHERE id = ?').run('ICON-HOME-Z-MISSING');
  inspection.close();

  const response = await app.inject({ method: 'GET', url: '/api/batches' });
  assert.equal(response.statusCode, 200);
  const summaries = response.json() as Array<{
    id: string;
    title: string;
    userStatus: string;
    createdAt: string;
    itemCounts: { total: number; add: number; replace: number; delete: number };
  }>;
  assert.equal(summaries.length, 20);
  assert.deepEqual(summaries.find((summary) => summary.id === 'ICON-HOME-Z-RETRY')?.itemCounts, { total: 3, add: 1, replace: 1, delete: 1 });
  assert.equal(summaries.find((summary) => summary.id === 'ICON-HOME-Z-RETRY')?.userStatus, 'delivery_retryable');
  assert.equal(summaries.find((summary) => summary.id === 'ICON-HOME-Z-MISSING')?.userStatus, 'developer_attention');
  for (let index = 1; index < summaries.length; index += 1) {
    const earlier = summaries[index - 1]!;
    const later = summaries[index]!;
    assert.ok(earlier.createdAt > later.createdAt || (earlier.createdAt === later.createdAt && earlier.id > later.id));
  }
  assert.deepEqual(Object.keys(summaries[0]!).sort(), ['createdAt', 'id', 'itemCounts', 'title', 'userStatus']);
  const serialized = JSON.stringify(summaries);
  for (const internalField of ['failureHistory', 'errorCode', 'deliveryCheckpoint', 'state', 'baseCommit', 'branch', 'commitSha', 'targetRepository', 'pushRepository', 'pullRequest']) {
    assert.equal(serialized.includes(internalField), false);
  }

  const one = await app.inject({ method: 'GET', url: '/api/batches?limit=1' });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as unknown[]).length, 1);
  assert.equal((one.json() as Array<{ id: string }>)[0]?.id, summaries[0]?.id);
  const twenty = await app.inject({ method: 'GET', url: '/api/batches?limit=20' });
  assert.equal(twenty.statusCode, 200);
  assert.equal((twenty.json() as unknown[]).length, 20);
  for (const invalid of ['0', 'nope', '21']) {
    const invalidLimit = await app.inject({ method: 'GET', url: `/api/batches?limit=${invalid}` });
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal((invalidLimit.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');
  }
});
