import { AppError } from './errors.js';
import type { GitHubRepositoryReader } from './github-client.js';
import type { RemoteDeliveryConfig, TargetRepository } from './types.js';

export interface GitRemoteReader {
  remoteUrl(remote: string): Promise<string>;
}

function expectedRemoteUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

function assertRemoteUrl(role: 'target' | 'push', actual: string, repository: string): void {
  if (actual !== expectedRemoteUrl(repository)) {
    throw new AppError(
      role === 'target' ? 'TARGET_REMOTE_URL_MISMATCH' : 'PUSH_REMOTE_URL_MISMATCH',
      `Configured ${role} remote does not exactly match ${repository}.`,
      500,
    );
  }
}

export function branchForBatch(batchId: string, prefix: 'bot/'): string {
  if (!/^ICON-\d{8}-[A-F0-9]{8}$/.test(batchId)) {
    throw new AppError('BOT_BRANCH_INVALID', 'Batch id cannot form a P3 bot branch.', 500);
  }
  return `${prefix}${batchId}`;
}

export class RemoteTopologyPreflight {
  constructor(
    private readonly git: GitRemoteReader,
    private readonly github: GitHubRepositoryReader,
    private readonly targetRepository: TargetRepository,
    private readonly delivery: RemoteDeliveryConfig,
  ) {}

  async verify(): Promise<void> {
    const [targetRemoteUrl, pushRemoteUrl] = await Promise.all([
      this.git.remoteUrl(this.delivery.targetRemote),
      this.git.remoteUrl(this.delivery.pushRemote),
    ]);
    assertRemoteUrl('target', targetRemoteUrl, this.targetRepository.repository);
    assertRemoteUrl('push', pushRemoteUrl, this.delivery.pushRepository);
    branchForBatch('ICON-20000101-ABCDEF12', this.delivery.pushBranchPrefix);
    const pushRepository = await this.github.getRepository(this.delivery.pushRepository);
    if (!pushRepository.fork || pushRepository.parentFullName !== this.targetRepository.repository) {
      throw new AppError('PUSH_FORK_PARENT_MISMATCH', 'Configured push repository is not a direct fork of the target repository.', 500);
    }
  }
}
