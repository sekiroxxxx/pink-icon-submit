import { buildApp } from './app.js';
import { BatchService } from './batch-service.js';
import { configFromEnv } from './config.js';
import { BatchDatabase } from './database.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { BatchStorage } from './storage.js';
import { LocalDiffWorker } from './worker.js';

const config = configFromEnv();
const database = new BatchDatabase(config.databasePath);
const batches = new BatchService(
  database,
  new BatchStorage(config.storageRoot),
  new GitRepository(config.repositoryPath, config.temporaryRoot, config.upstreamRemote, config.upstreamBranch),
  new IconBatchCli(),
  config.maxUploadBytes,
);
database.recoverInterruptedValidations();
database.recoverInterruptedJobs();
const worker = new LocalDiffWorker(batches);
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
