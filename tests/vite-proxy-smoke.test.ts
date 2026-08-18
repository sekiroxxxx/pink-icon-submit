import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createServer as createViteServer } from 'vite';

import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { createTestEnvironment } from './helpers.js';

const proxyHost = '127.0.0.2';
const proxyOrigin = `http://${proxyHost}:5173`;
const apiOrigin = `http://${proxyHost}:3000`;
const viteConfigPath = fileURLToPath(new URL('../web/vite.config.ts', import.meta.url));

test('a real Vite proxy preserves the browser Host so login and a write use the same Origin', async (t) => {
  const environment = await createTestEnvironment(t);
  const auth = new AuthService(environment.database);
  await auth.provisionBootstrapUser({ username: 'proxy@example.invalid', password: 'proxy password' });
  const app = await buildApp({ batches: environment.batches, auth, sessionCookieSecure: false });
  await app.listen({ host: proxyHost, port: 3000 });
  t.after(async () => app.close());

  const previousApiUrl = process.env.PINK_ICON_SUBMIT_API_URL;
  process.env.PINK_ICON_SUBMIT_API_URL = apiOrigin;
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.PINK_ICON_SUBMIT_API_URL;
    else process.env.PINK_ICON_SUBMIT_API_URL = previousApiUrl;
  });

  const vite = await createViteServer({
    configFile: viteConfigPath,
    logLevel: 'error',
    server: { host: proxyHost, port: 5173, strictPort: true },
  });
  t.after(async () => vite.close());
  await vite.listen();

  const login = await fetch(`${proxyOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: proxyOrigin },
    body: JSON.stringify({ username: 'proxy@example.invalid', password: 'proxy password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  assert.doesNotMatch(cookie, /; Secure/);

  const created = await fetch(`${proxyOrigin}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: proxyOrigin, cookie },
    body: JSON.stringify({
      title: 'Vite origin smoke',
      description: 'The real development proxy must preserve the browser origin.',
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { state: string }).state, 'DRAFT');
});
