import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../src/github-client.js';
import { branchForBatch, RemoteTopologyPreflight } from '../src/remote-preflight.js';
import type { GitHubRepositoryReader } from '../src/github-client.js';
import type { RemoteDeliveryConfig, TargetRepository } from '../src/types.js';

const targetRepository: TargetRepository = {
  repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
  branch: 'main',
};

const delivery: RemoteDeliveryConfig = {
  targetRemote: 'upstream',
  pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
  pushRemote: 'origin',
  pushBranchPrefix: 'bot/',
  githubToken: 'test-only-token',
  committer: {
    name: 'PinK Icon Bot',
    email: 'sud-icon-bot@users.noreply.github.com',
  },
};

class FakeGitHubRepositoryReader implements GitHubRepositoryReader {
  constructor(private readonly details: { fork: boolean; parentFullName: string | null }) {}

  async getRepository(): Promise<{ fork: boolean; parentFullName: string | null }> {
    return this.details;
  }
}

function preflight(remoteUrls: Record<string, string>, details = { fork: true, parentFullName: targetRepository.repository }): RemoteTopologyPreflight {
  return new RemoteTopologyPreflight(
    {
      async remoteUrl(remote: string): Promise<string> {
        const value = remoteUrls[remote];
        if (!value) {
          throw new Error(`Unknown remote ${remote}`);
        }
        return value;
      },
    },
    new FakeGitHubRepositoryReader(details),
    targetRepository,
    delivery,
  );
}

test('P3 preflight accepts only the configured R2 target and direct R3 fork', async () => {
  await preflight({
    upstream: 'https://github.com/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test.git',
    origin: 'https://github.com/sud-icon-bot/sekiroxxxx-pink-codicons-automation-test.git',
  }).verify();
  assert.equal(branchForBatch('ICON-20260806-ABCDEF12', 'bot/'), 'bot/ICON-20260806-ABCDEF12');
});

test('P3 preflight rejects a remote URL with credentials without exposing it', async () => {
  const unsafeUrl = 'https://secret@github.com/sud-icon-bot/sekiroxxxx-pink-codicons-automation-test.git';
  let githubRead = false;
  const guardedPreflight = new RemoteTopologyPreflight(
    {
      async remoteUrl(remote: string): Promise<string> {
        return remote === 'upstream'
          ? 'https://github.com/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test.git'
          : unsafeUrl;
      },
    },
    {
      async getRepository() {
        githubRead = true;
        return { fork: true, parentFullName: targetRepository.repository };
      },
    },
    targetRepository,
    delivery,
  );
  await assert.rejects(
    () => guardedPreflight.verify(),
    (error: unknown) => error instanceof Error && error.message.includes('push remote') && !error.message.includes('secret'),
  );
  assert.equal(githubRead, false);
});

test('P3 preflight rejects a non-direct R3 fork and invalid batch branch ids', async () => {
  await assert.rejects(
    () => preflight({
      upstream: 'https://github.com/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test.git',
      origin: 'https://github.com/sud-icon-bot/sekiroxxxx-pink-codicons-automation-test.git',
    }, { fork: true, parentFullName: 'SUD-GLOBAL/pink-codicons' }).verify(),
    /direct fork/,
  );
  assert.throws(() => branchForBatch('ICON-not-safe', 'bot/'), /cannot form/);
});

test('GitHub metadata reads keep the token out of the URL and error text', async () => {
  const token = 'test-only-token';
  let requestedUrl = '';
  let authorization = '';
  const client = new GitHubApiClient(token, async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ fork: true, parent: { full_name: targetRepository.repository } }), { status: 200 });
  });
  assert.deepEqual(await client.getRepository(delivery.pushRepository), {
    fork: true,
    parentFullName: targetRepository.repository,
  });
  assert.equal(requestedUrl.includes(token), false);
  assert.equal(authorization, `Bearer ${token}`);

  const unavailable = new GitHubApiClient(token, async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(
    () => unavailable.getRepository(delivery.pushRepository),
    (error: unknown) => error instanceof Error && !error.message.includes(token),
  );
});
