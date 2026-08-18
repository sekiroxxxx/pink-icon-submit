import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import { GitHubApiClient } from '../src/github-client.js';

test('GitHub PR lookup uses the authenticated target repository query and recognizes the machine marker', async () => {
  const token = 'test-only-token';
  let requestedUrl = '';
  let authorization = '';
  const client = new GitHubApiClient(token, async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify([{
      number: 41,
      html_url: 'https://github.example.invalid/target/pull/41',
      state: 'open',
      draft: true,
      created_at: '2026-08-06T00:00:00.000Z',
      body: '<!-- pink-icon-submit:batch=ICON-20260806-ABCDEF12 -->',
    }]), { status: 200 });
  });

  const lookup = await client.findPullRequest(
    'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    'sud-icon-bot:bot/ICON-20260806-ABCDEF12',
    '<!-- pink-icon-submit:batch=ICON-20260806-ABCDEF12 -->',
  );

  assert.equal(requestedUrl.includes(token), false);
  assert.match(requestedUrl, /state=all/);
  assert.match(requestedUrl, /head=sud-icon-bot%3Abot%2FICON-20260806-ABCDEF12/);
  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(lookup, {
    matching: {
      number: 41,
      url: 'https://github.example.invalid/target/pull/41',
      state: 'open',
      isDraft: true,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
    conflicting: null,
  });
});

test('GitHub Draft PR creation sends a draft body without putting the token in the URL or errors', async () => {
  const token = 'test-only-token';
  let requestedUrl = '';
  let authorization = '';
  let requestBody = '';
  const client = new GitHubApiClient(token, async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      number: 42,
      html_url: 'https://github.example.invalid/target/pull/42',
      state: 'open',
      draft: true,
      created_at: '2026-08-06T00:00:00.000Z',
    }), { status: 201 });
  });

  const created = await client.createDraftPullRequest('sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', {
    title: 'chore(icons): test',
    head: 'sud-icon-bot:bot/ICON-20260806-ABCDEF12',
    base: 'main',
    body: '<!-- pink-icon-submit:batch=ICON-20260806-ABCDEF12 -->',
  });

  assert.equal(requestedUrl, 'https://api.github.com/repos/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test/pulls');
  assert.equal(requestedUrl.includes(token), false);
  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(requestBody), {
    title: 'chore(icons): test',
    head: 'sud-icon-bot:bot/ICON-20260806-ABCDEF12',
    base: 'main',
    body: '<!-- pink-icon-submit:batch=ICON-20260806-ABCDEF12 -->',
    draft: true,
  });
  assert.equal(created.number, 42);

  const unavailable = new GitHubApiClient(token, async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(
    () => unavailable.createDraftPullRequest('sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', {
      title: 'test', head: 'sud-icon-bot:bot/test', base: 'main', body: 'test',
    }),
    (error: unknown) => error instanceof Error && !error.message.includes(token),
  );
});

test('GitHub requests abort at their deadline and a later request can complete', async () => {
  let calls = 0;
  const client = new GitHubApiClient('test-only-token', (_input, init) => {
    calls += 1;
    if (calls > 1) {
      return Promise.resolve(new Response(JSON.stringify({ fork: false }), { status: 200 }));
    }
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }, { timeoutMs: 100 });

  await assert.rejects(
    client.getRepository('example/repository'),
    (error: unknown) => error instanceof AppError && error.code === 'GITHUB_API_TIMEOUT',
  );
  assert.deepEqual(await client.getRepository('example/repository'), { fork: false, parentFullName: null });
});

test('GitHub deadline remains active while the response body is being read', async () => {
  const client = new GitHubApiClient('test-only-token', async (_input, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  }) as Response, { timeoutMs: 100 });

  await assert.rejects(
    client.getRepository('example/repository'),
    (error: unknown) => error instanceof AppError && error.code === 'GITHUB_API_TIMEOUT',
  );
});
