import { resolve } from 'node:path';

import type { AppConfig } from './types.js';

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
    upstreamRemote: environment.PINK_ICON_UPSTREAM_REMOTE ?? 'upstream',
    upstreamBranch: environment.PINK_ICON_UPSTREAM_BRANCH ?? 'main',
    workerPollIntervalMs: positiveInteger(environment.PINK_ICON_WORKER_POLL_MS, 1_000),
    maxUploadBytes: positiveInteger(environment.PINK_ICON_MAX_UPLOAD_BYTES, 1024 * 1024),
  };
}
