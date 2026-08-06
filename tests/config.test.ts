import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogOptionsFromConfig, configFromEnv } from '../src/config.js';

test('explicit local mode resolves the published beta catalog without inferring a remote target', () => {
  const config = configFromEnv({
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'local',
    PINK_ICON_STAGE1_SOURCE_DIR: 'C:\\workspace\\pink-codicons',
    PINK_ICON_LOCAL_TARGET_REF: 'main',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
  });

  assert.equal(config.executionMode, 'local');
  assert.equal(config.stage1SourcePath, 'C:\\workspace\\pink-codicons');
  assert.equal(config.localTargetRef, 'main');
  assert.equal(config.upstreamRemote, 'origin');
  assert.equal(config.upstreamBranch, 'main');
  assert.deepEqual(config.targetRepository, {
    repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    branch: 'main',
  });
  assert.deepEqual(catalogOptionsFromConfig(config), {
    packageName: '@pink/codicons',
    tag: 'beta',
    registryUrl: 'http://creator-npm.cocos.org:7001',
    sourceRepository: 'sud-global/pink-codicons',
    cacheRoot: config.catalogCacheRoot,
    refreshIntervalMs: 60_000,
  });
});

test('execution mode and Stage 1 v2 target repository must be explicit', () => {
  assert.throws(
    () => configFromEnv({ PINK_CODICONS_DIR: 'C:\\workspace\\pink-codicons' }),
    /PINK_ICON_EXECUTION_MODE/,
  );
  assert.throws(
    () => configFromEnv({
      PINK_CODICONS_DIR: 'C:\\workspace\\pink-codicons',
      PINK_ICON_EXECUTION_MODE: 'local',
      PINK_ICON_STAGE1_SOURCE_DIR: 'C:\\workspace\\pink-codicons',
      PINK_ICON_LOCAL_TARGET_REF: 'main',
    }),
    /PINK_ICON_TARGET_REPOSITORY/,
  );
});
