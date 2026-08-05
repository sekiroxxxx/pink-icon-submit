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
});
