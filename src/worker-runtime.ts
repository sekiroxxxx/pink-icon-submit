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
  close(): Promise<void>;
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
  async close() {},
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
  let closed = false;
  let activePoll: Promise<void> | null = null;
  const pollWorker = async (): Promise<void> => {
    if (closed || activePoll) {
      return;
    }
    const run = (async () => {
      try {
        await worker.processNext();
      } catch (error) {
        options.onError(error);
      }
    })();
    activePoll = run;
    await run.finally(() => {
      if (activePoll === run) activePoll = null;
    });
  };

  const timer = setInterval(() => {
    void pollWorker();
  }, options.pollIntervalMs);
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await activePoll;
    },
  };
}
