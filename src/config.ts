import { resolve } from 'node:path';

import type { AppConfig, NpmPackageCatalogOptions } from './types.js';

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

export function configFromEnv(environment = process.env): AppConfig {
  const repositoryPath = environment.PINK_CODICONS_DIR;
  if (!repositoryPath) {
    throw new Error('PINK_CODICONS_DIR must point to a local pink-codicons clone.');
  }

  const dataRoot = resolve(environment.PINK_ICON_SUBMIT_DATA_DIR ?? 'data');
  const resolvedRepositoryPath = resolve(repositoryPath);
  return {
    databasePath: resolve(dataRoot, 'pink-icon-submit.sqlite'),
    storageRoot: resolve(dataRoot, 'batches'),
    temporaryRoot: resolve(dataRoot, 'worktrees'),
    repositoryPath: resolvedRepositoryPath,
    upstreamRemote: environment.PINK_ICON_UPSTREAM_REMOTE ?? 'origin',
    upstreamBranch: environment.PINK_ICON_UPSTREAM_BRANCH ?? 'main',
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
