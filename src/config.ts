import { resolve } from 'node:path';

import type { AppConfig, ExecutionMode, NpmPackageCatalogOptions, TargetRepository } from './types.js';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function executionMode(value: string | undefined): ExecutionMode {
  if (value === 'local' || value === 'remote') {
    return value;
  }
  throw new Error('PINK_ICON_EXECUTION_MODE must be explicitly set to local or remote.');
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function targetRepositoryFromEnv(environment: NodeJS.ProcessEnv): TargetRepository {
  const repository = requiredEnvironmentValue(environment, 'PINK_ICON_TARGET_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('PINK_ICON_TARGET_REPOSITORY must be an owner/repository slug.');
  }
  const branch = environment.PINK_ICON_TARGET_BRANCH ?? 'main';
  if (branch !== 'main') {
    throw new Error('PINK_ICON_TARGET_BRANCH must be main for the Stage 1 v2 protocol.');
  }
  return { repository, branch };
}

export function configFromEnv(environment = process.env): AppConfig {
  const repositoryPath = environment.PINK_CODICONS_DIR;
  if (!repositoryPath) {
    throw new Error('PINK_CODICONS_DIR must point to a local pink-codicons clone.');
  }

  const mode = executionMode(environment.PINK_ICON_EXECUTION_MODE);
  const stage1SourcePath = mode === 'local'
    ? resolve(requiredEnvironmentValue(environment, 'PINK_ICON_STAGE1_SOURCE_DIR'))
    : undefined;
  const localTargetRef = mode === 'local'
    ? requiredEnvironmentValue(environment, 'PINK_ICON_LOCAL_TARGET_REF')
    : undefined;
  const dataRoot = resolve(environment.PINK_ICON_SUBMIT_DATA_DIR ?? 'data');
  const resolvedRepositoryPath = resolve(repositoryPath);
  return {
    databasePath: resolve(dataRoot, 'pink-icon-submit.sqlite'),
    storageRoot: resolve(dataRoot, 'batches'),
    temporaryRoot: resolve(dataRoot, 'worktrees'),
    repositoryPath: resolvedRepositoryPath,
    executionMode: mode,
    ...(stage1SourcePath ? { stage1SourcePath } : {}),
    ...(localTargetRef ? { localTargetRef } : {}),
    upstreamRemote: environment.PINK_ICON_UPSTREAM_REMOTE ?? 'origin',
    upstreamBranch: environment.PINK_ICON_UPSTREAM_BRANCH ?? 'main',
    targetRepository: targetRepositoryFromEnv(environment),
    catalogPackageName: environment.PINK_ICON_CATALOG_PACKAGE ?? '@pink/codicons',
    catalogTag: environment.PINK_ICON_CATALOG_TAG ?? 'beta',
    catalogRegistryUrl: environment.PINK_ICON_CATALOG_REGISTRY ?? 'http://creator-npm.cocos.org:7001',
    catalogAuthToken: environment.PINK_ICON_CATALOG_AUTH_TOKEN,
    catalogSourceRepository: environment.PINK_ICON_CATALOG_SOURCE_REPOSITORY ?? 'sud-global/pink-codicons',
    catalogCacheRoot: resolve(dataRoot, 'catalog-cache'),
    catalogRefreshIntervalMs: positiveInteger(environment.PINK_ICON_CATALOG_REFRESH_MS, 60_000),
    workerPollIntervalMs: positiveInteger(environment.PINK_ICON_WORKER_POLL_MS, 1_000),
    maxUploadBytes: positiveInteger(environment.PINK_ICON_MAX_UPLOAD_BYTES, 1024 * 1024),
  };
}

export function catalogOptionsFromConfig(config: AppConfig): NpmPackageCatalogOptions {
  return {
    packageName: config.catalogPackageName,
    tag: config.catalogTag,
    registryUrl: config.catalogRegistryUrl,
    ...(config.catalogAuthToken ? { authToken: config.catalogAuthToken } : {}),
    sourceRepository: config.catalogSourceRepository,
    cacheRoot: config.catalogCacheRoot,
    refreshIntervalMs: config.catalogRefreshIntervalMs,
  };
}
