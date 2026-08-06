import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { createTestEnvironment } from './helpers.js';

test('batch API stores uploads, validates through icon-batch, and exposes catalog', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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
    JSON.stringify({ action: 'add', designName: 'api-icon', description: 'API icon' }),
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
  const app = await buildApp({ batches: environment.batches });
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

test('delete replacement must select a different existing catalog icon', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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
  const app = await buildApp({ batches: environment.batches });
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
      targetName: 'existing-alias',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);
  assert.equal((item.json() as { targetName: string }).targetName, 'existing');
});

test('name preview delegates normalization and catalog collision checks to icon-batch', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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

test('warning acknowledgement is persisted for exactly one validation result before submission', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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
      designName: 'warning-icon',
      description: 'Triggers a test warning.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);
  const validated = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/validate` });
  assert.equal(validated.statusCode, 200);
  assert.equal((validated.json() as { warningsAcknowledged: boolean }).warningsAcknowledged, false);

  const blocked = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/submit` });
  assert.equal(blocked.statusCode, 409);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'BATCH_WARNINGS_UNACKNOWLEDGED');

  const acknowledged = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/warnings/acknowledge` });
  assert.equal(acknowledged.statusCode, 200);
  assert.equal((acknowledged.json() as { warningsAcknowledged: boolean }).warningsAcknowledged, true);

  const queued = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/submit` });
  assert.equal(queued.statusCode, 200);
  assert.equal((queued.json() as { state: string }).state, 'QUEUED');
});

test('catalog pages reuse the immutable npm snapshot across repeated reads', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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

test('batch creation rejects invalid designer email and design links', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
  t.after(() => app.close());

  const invalidEmail = await app.inject({
    method: 'POST',
    url: '/api/batches',
    payload: {
      title: 'Invalid email',
      description: 'Validation',
      designUrl: 'https://design.example.invalid/email',
      submitter: { name: 'Designer', email: 'not-an-email' },
    },
  });
  assert.equal(invalidEmail.statusCode, 400);
  assert.equal((invalidEmail.json() as { error: { code: string } }).error.code, 'REQUEST_INVALID');

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
});

test('oversized multipart SVG returns UPLOAD_TOO_LARGE', async (t) => {
  const environment = await createTestEnvironment(t);
  const app = await buildApp({ batches: environment.batches });
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
  const app = await buildApp({ batches: environment.batches });
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
