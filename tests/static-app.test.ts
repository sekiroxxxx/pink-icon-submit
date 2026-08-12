import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { createTestEnvironment } from './helpers.js';

test('production web root serves the SPA entry routes and built assets', async (t) => {
  const environment = await createTestEnvironment(t);
  const webRoot = await mkdtemp(join(tmpdir(), 'pink-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><script src="/app.js"></script>');
  await writeFile(join(webRoot, 'app.js'), 'globalThis.pink = true;');
  const app = await buildApp({
    batches: environment.batches,
    auth: new AuthService(environment.database),
    webRoot,
    requireWebRoot: true,
  });
  t.after(() => app.close());

  for (const url of ['/', '/workbench', '/workbench?batch=ICON-TEST']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<!doctype html>/);
  }
  const asset = await app.inject({ method: 'GET', url: '/app.js' });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /globalThis\.pink/);
});

test('production startup fails when the required web build is absent', async (t) => {
  const environment = await createTestEnvironment(t);
  await assert.rejects(
    buildApp({
      batches: environment.batches,
      auth: new AuthService(environment.database),
      webRoot: join(tmpdir(), `pink-missing-web-${Date.now()}`),
      requireWebRoot: true,
    }),
    /web build/i,
  );
});
