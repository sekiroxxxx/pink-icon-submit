import type { RemoteDeliveryPhase } from './types.js';
import type { WorkerResult } from './worker.js';

export interface WorkerRecoveryStore {
  recoverInterruptedJobs(): number;
  resumeBranchPushedJobs(): number;
}

export interface QueueWorker {
  processNext(): Promise<WorkerResult>;
}

export interface WorkerRuntime {
  close(): void;
}

export interface WorkerRuntimeOptions {
  enabled: boolean;
  pollIntervalMs: number;
  deliveryPhase?: RemoteDeliveryPhase;
  recovery: WorkerRecoveryStore;
  preflight?: () => Promise<void>;
  createWorker: () => QueueWorker;
  onError: (error: unknown) => void;
}

const disabledRuntime: WorkerRuntime = {
  close() {},
};

export async function startWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  if (!options.enabled) {
    return disabledRuntime;
  }

  await options.preflight?.();
  options.recovery.recoverInterruptedJobs();
  if (options.deliveryPhase === 'pull_request') {
    options.recovery.resumeBranchPushedJobs();
  }

  const worker = options.createWorker();
  let workerRunning = false;
  const pollWorker = async (): Promise<void> => {
    if (workerRunning) {
      return;
    }
    workerRunning = true;
    try {
      await worker.processNext();
    } catch (error) {
      options.onError(error);
    } finally {
      workerRunning = false;
    }
  };

  const timer = setInterval(() => {
    void pollWorker();
  }, options.pollIntervalMs);
  return {
    close() {
      clearInterval(timer);
    },
  };
}
