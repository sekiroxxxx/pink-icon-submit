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
  assert.equal(config.workerEnabled, false);
  assert.equal(config.stage1SourcePath, 'C:\\workspace\\pink-codicons');
  assert.equal(config.localTargetRef, 'main');
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

test('remote mode requires the fixed P3 R2/R3 topology and explicit delivery settings', () => {
  const config = configFromEnv({
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'remote',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    PINK_ICON_TARGET_BRANCH: 'main',
    PINK_ICON_TARGET_REMOTE: 'upstream',
    PINK_ICON_PUSH_REPOSITORY: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    PINK_ICON_PUSH_REMOTE: 'origin',
    PINK_ICON_PUSH_BRANCH_PREFIX: 'bot/',
    PINK_ICON_REMOTE_DELIVERY_PHASE: 'pull_request',
    PINK_ICON_GITHUB_TOKEN: 'test-only-token',
    PINK_ICON_GIT_COMMITTER_NAME: 'PinK Icon Bot',
    PINK_ICON_GIT_COMMITTER_EMAIL: 'sud-icon-bot@users.noreply.github.com',
  });

  assert.equal(config.executionMode, 'remote');
  assert.equal(config.workerEnabled, false);
  assert.deepEqual(config.remoteDelivery && {
    targetRemote: config.remoteDelivery.targetRemote,
    pushRepository: config.remoteDelivery.pushRepository,
    pushRemote: config.remoteDelivery.pushRemote,
    pushBranchPrefix: config.remoteDelivery.pushBranchPrefix,
    deliveryPhase: config.remoteDelivery.deliveryPhase,
    committer: config.remoteDelivery.committer,
  }, {
    targetRemote: 'upstream',
    pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    pushRemote: 'origin',
    pushBranchPrefix: 'bot/',
    deliveryPhase: 'pull_request',
    committer: {
      name: 'PinK Icon Bot',
      email: 'sud-icon-bot@users.noreply.github.com',
    },
  });
});

test('remote mode rejects an implicit branch, production target, and an unsafe branch prefix', () => {
  const common = {
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'remote',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    PINK_ICON_TARGET_REMOTE: 'upstream',
    PINK_ICON_PUSH_REPOSITORY: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    PINK_ICON_PUSH_REMOTE: 'origin',
    PINK_ICON_PUSH_BRANCH_PREFIX: 'bot/',
    PINK_ICON_REMOTE_DELIVERY_PHASE: 'pull_request',
    PINK_ICON_GITHUB_TOKEN: 'test-only-token',
    PINK_ICON_GIT_COMMITTER_NAME: 'PinK Icon Bot',
    PINK_ICON_GIT_COMMITTER_EMAIL: 'sud-icon-bot@users.noreply.github.com',
  };
  assert.throws(() => configFromEnv(common), /PINK_ICON_TARGET_BRANCH/);
  assert.throws(() => configFromEnv({ ...common, PINK_ICON_TARGET_BRANCH: 'main', PINK_ICON_TARGET_REPOSITORY: 'SUD-GLOBAL\/pink-codicons' }), /only permits/);
  assert.throws(() => configFromEnv({ ...common, PINK_ICON_TARGET_BRANCH: 'main', PINK_ICON_PUSH_BRANCH_PREFIX: 'icon-request/' }), /must be bot/);
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

test('worker execution is disabled by default and requires an explicit true value', () => {
  const environment = {
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'local',
    PINK_ICON_STAGE1_SOURCE_DIR: 'C:\\workspace\\pink-codicons',
    PINK_ICON_LOCAL_TARGET_REF: 'main',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
  };

  assert.equal(configFromEnv(environment).workerEnabled, false);
  assert.equal(configFromEnv({ ...environment, PINK_ICON_WORKER_ENABLED: 'true' }).workerEnabled, true);
  assert.equal(configFromEnv({ ...environment, PINK_ICON_WORKER_ENABLED: 'false' }).workerEnabled, false);
  assert.throws(() => configFromEnv({ ...environment, PINK_ICON_WORKER_ENABLED: '1' }), /PINK_ICON_WORKER_ENABLED/);
});

test('session cookie transport is explicit: localhost defaults to false and invalid values fail fast', () => {
  const environment = {
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'local',
    PINK_ICON_STAGE1_SOURCE_DIR: 'C:\\workspace\\pink-codicons',
    PINK_ICON_LOCAL_TARGET_REF: 'main',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
  };

  assert.equal(configFromEnv(environment).sessionCookieSecure, false);
  assert.equal(configFromEnv({ ...environment, PINK_ICON_SESSION_COOKIE_SECURE: 'true' }).sessionCookieSecure, true);
  assert.equal(configFromEnv({ ...environment, PINK_ICON_SESSION_COOKIE_SECURE: 'false' }).sessionCookieSecure, false);
  assert.throws(() => configFromEnv({ ...environment, PINK_ICON_SESSION_COOKIE_SECURE: '1' }), /PINK_ICON_SESSION_COOKIE_SECURE/);
});

test('bootstrap credentials are optional but must be configured as a valid pair', () => {
  const environment = {
    PINK_CODICONS_DIR: 'C:\\workspace\\target-clone',
    PINK_ICON_EXECUTION_MODE: 'local',
    PINK_ICON_STAGE1_SOURCE_DIR: 'C:\\workspace\\pink-codicons',
    PINK_ICON_LOCAL_TARGET_REF: 'main',
    PINK_ICON_TARGET_REPOSITORY: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
  };

  assert.equal(configFromEnv(environment).bootstrapUser, undefined);
  assert.deepEqual(configFromEnv({
    ...environment,
    PINK_ICON_BOOTSTRAP_USERNAME: 'designer@example.invalid',
    PINK_ICON_BOOTSTRAP_PASSWORD: 'test-only-password',
  }).bootstrapUser, {
    username: 'designer@example.invalid',
    password: 'test-only-password',
  });
  assert.throws(() => configFromEnv({ ...environment, PINK_ICON_BOOTSTRAP_USERNAME: 'designer@example.invalid' }), /set together/);
  assert.throws(() => configFromEnv({ ...environment, PINK_ICON_BOOTSTRAP_USERNAME: 'not-an-email', PINK_ICON_BOOTSTRAP_PASSWORD: 'test-only-password' }), /internal email/);
});
