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
