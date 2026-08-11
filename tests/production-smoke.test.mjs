import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitFor(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production server exited early (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Startup has not reached listen yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Production server did not become ready.\n${output()}`);
}

test('built npm start serves the SPA and accepts HTTPS-origin authenticated writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-production-smoke-'));
  const data = join(root, 'data');
  const repository = join(root, 'repository');
  const stage1 = join(root, 'stage1');
  await Promise.all([mkdir(data), mkdir(repository), mkdir(stage1)]);
  const port = await availablePort();
  const publicOrigin = 'https://pink.example.invalid';
  const username = 'production-smoke@example.invalid';
  const password = 'production-smoke-password';
  const inherited = Object.fromEntries([
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: resolve('.'),
    env: {
      ...inherited,
      PINK_CODICONS_DIR: repository,
      PINK_ICON_EXECUTION_MODE: 'local',
      PINK_ICON_STAGE1_SOURCE_DIR: stage1,
      PINK_ICON_LOCAL_TARGET_REF: 'main',
      PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
      PINK_ICON_SUBMIT_DATA_DIR: data,
      PINK_ICON_SUBMIT_HOST: '127.0.0.1',
      PINK_ICON_SUBMIT_PORT: String(port),
      PINK_ICON_WORKER_ENABLED: 'false',
      PINK_ICON_SESSION_COOKIE_SECURE: 'true',
      PINK_ICON_PUBLIC_ORIGIN: publicOrigin,
      PINK_ICON_BOOTSTRAP_USERNAME: username,
      PINK_ICON_BOOTSTRAP_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const output = () => `${stdout}\n${stderr}`;
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`, child, output);
  const ready = await fetch(`${base}/api/ready`);
  assert.equal(ready.status, 200);

  for (const path of ['/', '/workbench']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/);
    const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(assetPath, 'built index should reference a fingerprinted asset');
    assert.equal((await fetch(`${base}${assetPath}`)).status, 200);
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicOrigin },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200, await login.text());
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie?.includes('Secure'));
  const cookie = setCookie.split(';', 1)[0];
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, origin: publicOrigin },
  });
  assert.equal(logout.status, 204, await logout.text());
  assert.doesNotMatch(output(), /production-smoke-password/);
});
