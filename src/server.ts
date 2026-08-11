import { buildApp } from './app.js';
import { AuthService } from './auth.js';
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
import { startWorkerRuntime } from './worker-runtime.js';

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

const database = new BatchDatabase(config.databasePath);
const auth = new AuthService(database);
if (config.bootstrapUser) {
  await auth.provisionBootstrapUser(config.bootstrapUser);
}
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
const app = await buildApp({ batches, auth, sessionCookieSecure: config.sessionCookieSecure });
let github: GitHubApiClient | undefined;
const remoteGithub = (): GitHubApiClient => {
  if (!config.remoteDelivery) {
    throw new Error('Remote GitHub client requested without remote delivery configuration.');
  }
  github ??= new GitHubApiClient(config.remoteDelivery.githubToken);
  return github;
};

const workerRuntime = await startWorkerRuntime({
  enabled: config.workerEnabled,
  pollIntervalMs: config.workerPollIntervalMs,
  ...(config.remoteDelivery ? {
    deliveryPhase: config.remoteDelivery.deliveryPhase,
    preflight: async () => new RemoteTopologyPreflight(
      repository,
      remoteGithub(),
      config.targetRepository,
      config.remoteDelivery!,
    ).verify(),
  } : {}),
  recovery: database,
  createWorker: () => config.remoteDelivery
    ? new RemoteBranchWorker(batches, {
      pushRemote: config.remoteDelivery.pushRemote,
      pushRepository: config.remoteDelivery.pushRepository,
      pushBranchPrefix: config.remoteDelivery.pushBranchPrefix,
      deliveryPhase: config.remoteDelivery.deliveryPhase,
      committer: config.remoteDelivery.committer,
      targetRepository: config.targetRepository,
      github: remoteGithub(),
      authentication: {
        username: config.remoteDelivery.pushRepository.split('/')[0],
        token: config.remoteDelivery.githubToken,
      },
    })
    : new LocalDiffWorker(batches),
  onError: (error) => app.log.error(error),
});
console.info(`PinK Icon Worker ${config.workerEnabled ? 'enabled' : 'disabled (API-only mode)'}.`);

app.addHook('onClose', async () => {
  workerRuntime.close();
  database.close();
});

const host = process.env.PINK_ICON_SUBMIT_HOST ?? '127.0.0.1';
const port = Number(process.env.PINK_ICON_SUBMIT_PORT ?? '3000');
await app.listen({ host, port });
