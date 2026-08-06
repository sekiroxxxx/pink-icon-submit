import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogOptionsFromConfig, configFromEnv } from '../src/config.js';

test('development defaults target origin/main and resolves the published beta catalog', () => {
  const config = configFromEnv({ PINK_CODICONS_DIR: 'C:\\workspace\\pink-codicons' });

  assert.equal(config.upstreamRemote, 'origin');
  assert.equal(config.upstreamBranch, 'main');
  assert.deepEqual(catalogOptionsFromConfig(config), {
    packageName: '@pink/codicons',
    tag: 'beta',
    registryUrl: 'http://creator-npm.cocos.org:7001',
    sourceRepository: 'sud-global/pink-codicons',
    cacheRoot: config.catalogCacheRoot,
    refreshIntervalMs: 60_000,
  });
});
