import { buildApp } from './app.js';
import { BatchService } from './batch-service.js';
import { catalogOptionsFromConfig, configFromEnv } from './config.js';
import { BatchDatabase } from './database.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { BatchStorage } from './storage.js';
import { LocalDiffWorker } from './worker.js';
import { GitHubApiClient } from './github-client.js';
import { RemoteTopologyPreflight } from './remote-preflight.js';
import { RemoteBranchWorker } from './remote-branch-worker.js';

const config = configFromEnv();
const repository = new GitRepository(config.repositoryPath, config.temporaryRoot, {
  mode: config.executionMode,
  ...(config.localTargetRef ? { localTargetRef: config.localTargetRef } : {}),
  ...(config.remoteDelivery ? {
    targetRemote: config.remoteDelivery.targetRemote,
    targetBranch: config.targetRepository.branch,
    remoteAuthentication: {
      username: config.remoteDelivery.pushRepository.split('/')[0],
      token: config.remoteDelivery.githubToken,
    },
  } : {}),
});
const github = config.remoteDelivery ? new GitHubApiClient(config.remoteDelivery.githubToken) : undefined;
if (config.remoteDelivery && github) {
  await new RemoteTopologyPreflight(
    repository,
    github,
    config.targetRepository,
    config.remoteDelivery,
  ).verify();
}

const database = new BatchDatabase(config.databasePath);
const batches = new BatchService(
  database,
  new BatchStorage(config.storageRoot),
  repository,
  new IconBatchCli(config.stage1SourcePath ? { sourceDirectory: config.stage1SourcePath } : {}),
  config.maxUploadBytes,
  catalogOptionsFromConfig(config),
  config.targetRepository,
  {
    executionMode: config.executionMode,
    pushRepository: config.remoteDelivery?.pushRepository ?? null,
    pushBranchPrefix: config.remoteDelivery?.pushBranchPrefix ?? null,
  },
);
database.recoverInterruptedValidations();
database.recoverInterruptedJobs();
if (config.remoteDelivery) {
  database.resumeBranchPushedJobs();
}
const worker = config.remoteDelivery
  ? new RemoteBranchWorker(batches, {
    pushRemote: config.remoteDelivery.pushRemote,
    pushRepository: config.remoteDelivery.pushRepository,
    pushBranchPrefix: config.remoteDelivery.pushBranchPrefix,
    committer: config.remoteDelivery.committer,
    targetRepository: config.targetRepository,
    github: github!,
    authentication: {
      username: config.remoteDelivery.pushRepository.split('/')[0],
      token: config.remoteDelivery.githubToken,
    },
  })
  : new LocalDiffWorker(batches);
const app = await buildApp({ batches });

let workerRunning = false;
const pollWorker = async (): Promise<void> => {
  if (workerRunning) {
    return;
  }
  workerRunning = true;
  try {
    await worker.processNext();
  } catch (error) {
    app.log.error(error);
  } finally {
    workerRunning = false;
  }
};

const workerTimer = setInterval(() => {
  void pollWorker();
}, config.workerPollIntervalMs);

app.addHook('onClose', async () => {
  clearInterval(workerTimer);
  database.close();
});

const host = process.env.PINK_ICON_SUBMIT_HOST ?? '127.0.0.1';
const port = Number(process.env.PINK_ICON_SUBMIT_PORT ?? '3000');
await app.listen({ host, port });
