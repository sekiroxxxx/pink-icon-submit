import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AuthService } from '../src/auth.js';
import { BatchDatabase } from '../src/database.js';
import { runManageUser } from '../src/manage-user.js';
import { RuntimeLease } from '../src/runtime-lease.js';

test('user management creates, rotates, disables, and revokes every session without exposing passwords', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pink-icon-submit-manage-user-'));
  t.after(async () => rm(dataRoot, { recursive: true, force: true }));
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (message: string) => output.push(message), stderr: (message: string) => errors.push(message) };
  const environment = { PINK_ICON_SUBMIT_DATA_DIR: dataRoot, PINK_ICON_MANAGE_USER_PASSWORD: 'first-secret-value' };

  assert.equal(await runManageUser(['create', ' Designer@Example.Invalid '], environment, io), 0);
  assert.equal(await runManageUser(['create', 'designer@example.invalid'], environment, io), 1);

  const databasePath = join(dataRoot, 'pink-icon-submit.sqlite');
  let database = new BatchDatabase(databasePath);
  let auth = new AuthService(database);
  const first = await auth.login({ username: 'designer@example.invalid', password: 'first-secret-value' });
  const second = await auth.login({ username: 'designer@example.invalid', password: 'first-secret-value' });
  assert.ok(auth.authenticate(first.token));
  assert.ok(auth.authenticate(second.token));
  database.close();

  environment.PINK_ICON_MANAGE_USER_PASSWORD = 'second-secret-value';
  assert.equal(await runManageUser(['rotate-password', 'DESIGNER@example.invalid'], environment, io), 0);
  database = new BatchDatabase(databasePath);
  auth = new AuthService(database);
  assert.equal(auth.authenticate(first.token), undefined);
  await assert.rejects(auth.login({ username: 'designer@example.invalid', password: 'first-secret-value' }));
  const rotated = await auth.login({ username: 'designer@example.invalid', password: 'second-secret-value' });
  assert.ok(auth.authenticate(rotated.token));
  database.close();

  assert.equal(await runManageUser(['disable', 'designer@example.invalid'], { PINK_ICON_SUBMIT_DATA_DIR: dataRoot }, io), 0);
  database = new BatchDatabase(databasePath);
  auth = new AuthService(database);
  assert.equal(auth.authenticate(rotated.token), undefined);
  await assert.rejects(auth.login({ username: 'designer@example.invalid', password: 'second-secret-value' }));
  await auth.provisionBootstrapUser({ username: 'designer@example.invalid', password: 'bootstrap-must-not-reactivate' });
  await assert.rejects(auth.login({ username: 'designer@example.invalid', password: 'bootstrap-must-not-reactivate' }));
  database.close();

  assert.equal(await runManageUser(['rotate-password', 'missing@example.invalid'], environment, io), 1);
  assert.equal(await runManageUser(['disable', 'missing@example.invalid'], { PINK_ICON_SUBMIT_DATA_DIR: dataRoot }, io), 1);
  assert.equal(await runManageUser(['create', 'another@example.invalid'], { PINK_ICON_SUBMIT_DATA_DIR: dataRoot }, io), 1);

  const serialized = JSON.stringify({ output, errors });
  assert.doesNotMatch(serialized, /first-secret-value|second-secret-value/);
  const inspection = new Database(databasePath, { readonly: true });
  assert.equal((inspection.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 0);
  assert.equal((inspection.prepare('SELECT password_hash FROM users WHERE username = ?').get('designer@example.invalid') as { password_hash: string }).password_hash, 'disabled');
  inspection.close();
});

test('user management rejects password-shaped command arguments', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pink-icon-submit-manage-user-args-'));
  t.after(async () => rm(dataRoot, { recursive: true, force: true }));
  const errors: string[] = [];
  const result = await runManageUser(
    ['create', 'designer@example.invalid', 'must-not-be-an-argument'],
    { PINK_ICON_SUBMIT_DATA_DIR: dataRoot, PINK_ICON_MANAGE_USER_PASSWORD: 'environment-only-secret' },
    { stdout: () => undefined, stderr: (message) => errors.push(message) },
  );
  assert.equal(result, 1);
  assert.deepEqual(errors, ['Usage: node dist/manage-user.js <create|rotate-password|disable> <username>']);
});

test('user management requires exclusive ownership of the stopped data directory', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pink-icon-submit-manage-user-lease-'));
  const databasePath = join(dataRoot, 'pink-icon-submit.sqlite');
  const database = new BatchDatabase(databasePath);
  database.close();
  const lease = RuntimeLease.acquire(`${databasePath}.runtime-lock`);
  t.after(async () => {
    lease.close();
    await rm(dataRoot, { recursive: true, force: true });
  });
  const errors: string[] = [];

  const result = await runManageUser(
    ['create', 'blocked@example.invalid'],
    { PINK_ICON_SUBMIT_DATA_DIR: dataRoot, PINK_ICON_MANAGE_USER_PASSWORD: 'not-written' },
    { stdout: () => assert.fail('A locked data directory must not be modified.'), stderr: (message) => errors.push(message) },
  );

  assert.equal(result, 1);
  assert.match(errors[0] ?? '', /already owns this data directory/i);
  const inspection = new Database(databasePath, { readonly: true });
  assert.equal(inspection.prepare('SELECT id FROM users WHERE username = ?').get('blocked@example.invalid'), undefined);
  inspection.close();
});

test('disabling the legacy account cannot be undone by retained bootstrap configuration', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pink-icon-submit-manage-user-legacy-'));
  t.after(async () => rm(dataRoot, { recursive: true, force: true }));
  const databasePath = join(dataRoot, 'pink-icon-submit.sqlite');
  let database = new BatchDatabase(databasePath);
  database.close();

  assert.equal(await runManageUser(
    ['disable', 'legacy-bootstrap@internal.invalid'],
    { PINK_ICON_SUBMIT_DATA_DIR: dataRoot },
    { stdout: () => undefined, stderr: (message) => assert.fail(message) },
  ), 0);

  database = new BatchDatabase(databasePath);
  const auth = new AuthService(database);
  await auth.provisionBootstrapUser({
    username: 'legacy-bootstrap@internal.invalid',
    password: 'must-not-reactivate',
  });
  await assert.rejects(auth.login({
    username: 'legacy-bootstrap@internal.invalid',
    password: 'must-not-reactivate',
  }));
  database.close();
});
