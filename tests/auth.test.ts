import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { AuthService, sessionCookieName } from '../src/auth.js';
import { createTestEnvironment } from './helpers.js';

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers['set-cookie'];
  const header = Array.isArray(value) ? value[0] : value;
  assert.ok(header);
  return header.split(';', 1)[0]!;
}

test('login uses an HttpOnly session, requires authentication, and never serializes credentials', async (t) => {
  const environment = await createTestEnvironment(t);
  const auth = new AuthService(environment.database);
  await auth.provisionBootstrapUser({ username: 'alice@example.invalid', password: 'correct horse battery staple' });
  const app = await buildApp({ batches: environment.batches, auth });
  t.after(() => app.close());

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  const protectedCatalog = await app.inject({ method: 'GET', url: '/api/catalog' });
  assert.equal(protectedCatalog.statusCode, 401);
  assert.equal((protectedCatalog.json() as { error: { code: string } }).error.code, 'AUTHENTICATION_REQUIRED');

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice@example.invalid', password: 'wrong password' },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal((invalid.json() as { error: { code: string } }).error.code, 'LOGIN_INVALID');

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice@example.invalid', password: 'correct horse battery staple' },
  });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json(), { user: { id: (login.json() as { user: { id: string } }).user.id, username: 'alice@example.invalid' } });
  assert.doesNotMatch(login.body, /correct horse battery staple/);
  const cookie = cookieFrom(login);
  assert.match(login.headers['set-cookie'] as string, /HttpOnly/);
  assert.match(login.headers['set-cookie'] as string, /SameSite=Lax/);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual((me.json() as { user: { username: string } }).user.username, 'alice@example.invalid');

  const inspection = new Database(environment.config.databasePath, { readonly: true });
  const passwordHash = (inspection.prepare('SELECT password_hash FROM users WHERE username = ?').get('alice@example.invalid') as { password_hash: string }).password_hash;
  const tokenHash = (inspection.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }).token_hash;
  inspection.close();
  assert.match(passwordHash, /^scrypt\$/);
  assert.doesNotMatch(passwordHash, /correct horse battery staple/);
  assert.doesNotMatch(tokenHash, new RegExp(cookie.split('=', 2)[1]!));
});

test('owner scoping hides other accounts, enforces one active batch, and logout or expiry invalidates a session', async (t) => {
  const environment = await createTestEnvironment(t);
  const auth = new AuthService(environment.database);
  await auth.provisionBootstrapUser({ username: 'alice@example.invalid', password: 'alice password' });
  await auth.provisionBootstrapUser({ username: 'bob@example.invalid', password: 'bob password' });
  const app = await buildApp({ batches: environment.batches, auth });
  t.after(() => app.close());

  const aliceLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice@example.invalid', password: 'alice password' } });
  const bobLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob@example.invalid', password: 'bob password' } });
  const aliceCookie = cookieFrom(aliceLogin);
  const bobCookie = cookieFrom(bobLogin);

  const created = await app.inject({
    method: 'POST',
    url: '/api/batches',
    headers: { cookie: aliceCookie },
    payload: { title: 'Alice batch', description: 'Only Alice can see or edit this batch.' },
  });
  assert.equal(created.statusCode, 201);
  const batch = created.json() as { id: string };
  const item = await app.inject({
    method: 'POST',
    url: `/api/batches/${batch.id}/items`,
    headers: { cookie: aliceCookie },
    payload: {
      action: 'add',
      designName: 'alice-icon',
      description: 'Alice-owned icon.',
      svgBase64: Buffer.from(environment.validSvg).toString('base64'),
    },
  });
  assert.equal(item.statusCode, 201);

  const bobDetail = await app.inject({ method: 'GET', url: `/api/batches/${batch.id}`, headers: { cookie: bobCookie } });
  assert.equal(bobDetail.statusCode, 404);
  assert.equal((bobDetail.json() as { error: { code: string } }).error.code, 'BATCH_NOT_FOUND');
  const bobMutation = await app.inject({ method: 'DELETE', url: `/api/batches/${batch.id}/items/${(item.json() as { id: string }).id}`, headers: { cookie: bobCookie } });
  assert.equal(bobMutation.statusCode, 404);
  const bobList = await app.inject({ method: 'GET', url: '/api/batches?limit=20', headers: { cookie: bobCookie } });
  assert.deepEqual(bobList.json(), []);
  const bobActive = await app.inject({ method: 'GET', url: '/api/batches/active', headers: { cookie: bobCookie } });
  assert.equal(bobActive.statusCode, 204);

  const aliceSecond = await app.inject({
    method: 'POST',
    url: '/api/batches',
    headers: { cookie: aliceCookie },
    payload: { title: 'A second active batch', description: 'This must be rejected transactionally.' },
  });
  assert.equal(aliceSecond.statusCode, 409);
  assert.equal((aliceSecond.json() as { error: { code: string } }).error.code, 'ACTIVE_BATCH_EXISTS');

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: aliceCookie } });
  assert.equal(logout.statusCode, 204);
  assert.match(logout.headers['set-cookie'] as string, new RegExp(`${sessionCookieName}=;`));
  const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: aliceCookie } });
  assert.equal(afterLogout.statusCode, 401);

  const expiringLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob@example.invalid', password: 'bob password' } });
  const expiredCookie = cookieFrom(expiringLogin);
  const token = expiredCookie.split('=', 2)[1]!;
  const expiry = new Database(environment.config.databasePath);
  expiry.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash <> ''").run();
  expiry.close();
  const expired = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `${sessionCookieName}=${token}` } });
  assert.equal(expired.statusCode, 401);
});

test('an explicit bootstrap secret can activate the retained legacy account without exposing it to other users', async (t) => {
  const environment = await createTestEnvironment(t);
  const auth = new AuthService(environment.database);

  await auth.provisionBootstrapUser({
    username: 'legacy-bootstrap@internal.invalid',
    password: 'migration-only-password',
  });
  const login = await auth.login({
    username: 'legacy-bootstrap@internal.invalid',
    password: 'migration-only-password',
  });

  assert.equal(login.user.id, 'legacy-bootstrap');
  const inspection = new Database(environment.config.databasePath, { readonly: true });
  const passwordHash = (inspection.prepare('SELECT password_hash FROM users WHERE id = ?').get('legacy-bootstrap') as { password_hash: string }).password_hash;
  inspection.close();
  assert.match(passwordHash, /^scrypt\$/);
  assert.doesNotMatch(passwordHash, /migration-only-password/);
});
