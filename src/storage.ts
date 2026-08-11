import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { AppError } from './errors.js';
import type { StoredBatch, StoredItem } from './types.js';

export class BatchStorage {
  constructor(private readonly rootDirectory: string) {}

  async saveSvg(batchId: string, itemId: string, content: Buffer): Promise<string> {
    const relativePath = `uploads/${itemId}.svg`;
    const outputPath = this.resolveBatchPath(batchId, relativePath);
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, content);
    return relativePath;
  }

  async copySvg(sourceBatchId: string, sourceFile: string, targetBatchId: string, targetItemId: string): Promise<string> {
    const content = await readFile(this.resolveBatchPath(sourceBatchId, sourceFile));
    return this.saveSvg(targetBatchId, targetItemId, content);
  }

  /**
   * Prepare every cloned SVG outside of the destination batch directory.  A
   * caller can therefore prove that all source uploads are readable before it
   * creates the new batch record.
   */
  async stageCloneSvgs(sourceBatchId: string, files: ReadonlyArray<{ sourceFile: string; targetItemId: string }>): Promise<StagedClone> {
    const root = this.storageRoot();
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, '.clone-'));
    this.assertOwnedPath(directory, root);
    try {
      for (const file of files) {
        const content = await readFile(this.resolveBatchPath(sourceBatchId, file.sourceFile));
        const relativePath = `uploads/${file.targetItemId}.svg`;
        const outputPath = this.resolveWithin(directory, relativePath);
        await mkdir(resolve(outputPath, '..'), { recursive: true });
        await writeFile(outputPath, content);
      }
      return { directory };
    } catch (error) {
      try {
        await this.discardCloneStaging({ directory });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Clone SVG staging failed and could not be fully cleaned up.');
      }
      throw error;
    }
  }

  async publishStagedClone(staging: StagedClone, targetBatchId: string): Promise<void> {
    const root = this.storageRoot();
    this.assertOwnedPath(staging.directory, root);
    const target = this.resolveBatchDirectory(targetBatchId);
    await rename(staging.directory, target);
  }

  async discardCloneStaging(staging: StagedClone): Promise<void> {
    this.assertOwnedPath(staging.directory, this.storageRoot());
    await rm(staging.directory, { recursive: true, force: true });
  }

  async discardClonedBatch(batchId: string): Promise<void> {
    const directory = this.resolveBatchDirectory(batchId);
    await rm(directory, { recursive: true, force: true });
  }

  async writeRequest(batch: StoredBatch, items: StoredItem[]): Promise<string> {
    if (!batch.catalogBaseline || !batch.targetRepository) {
      throw new AppError('BATCH_PROTOCOL_CONTEXT_MISSING', `Batch ${batch.id} predates the Stage 1 v2 protocol and must be recreated.`, 409);
    }
    const requestPath = this.resolveBatchPath(batch.id, 'request.json');
    await mkdir(resolve(requestPath, '..'), { recursive: true });
    const request = {
      schemaVersion: 2,
      batchId: batch.id,
      catalogBaseline: batch.catalogBaseline,
      targetRepository: batch.targetRepository,
      title: batch.title,
      description: batch.description,
      ...(batch.designUrl ? { designUrl: batch.designUrl } : {}),
      submitter: batch.submitter,
      items: items.map((item) => this.toRequestItem(item)),
    };
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    return requestPath;
  }

  async writePlan(batchId: string, plan: unknown): Promise<string> {
    const planPath = this.resolveBatchPath(batchId, 'plan.json');
    await mkdir(resolve(planPath, '..'), { recursive: true });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return planPath;
  }

  private resolveBatchPath(batchId: string, relativePath: string): string {
    return join(this.rootDirectory, batchId, relativePath);
  }

  private storageRoot(): string {
    return resolve(this.rootDirectory);
  }

  private resolveBatchDirectory(batchId: string): string {
    const directory = resolve(this.storageRoot(), batchId);
    this.assertOwnedPath(directory, this.storageRoot());
    return directory;
  }

  private resolveWithin(directory: string, relativePath: string): string {
    const output = resolve(directory, relativePath);
    this.assertOwnedPath(output, directory);
    return output;
  }

  private assertOwnedPath(candidate: string, owner: string): void {
    const relativePath = relative(resolve(owner), resolve(candidate));
    if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes(':')) {
      throw new AppError('STORAGE_PATH_INVALID', 'Storage path is outside its owned directory.', 500);
    }
  }

  private toRequestItem(item: StoredItem): Record<string, unknown> {
    if (item.action === 'add') {
      return {
        id: item.id,
        action: item.action,
        designName: item.designName,
        description: item.description,
        sourceFile: item.sourceFile,
      };
    }
    if (item.action === 'replace') {
      return {
        id: item.id,
        action: item.action,
        targetName: item.targetName,
        ...(item.description ? { description: item.description } : {}),
        sourceFile: item.sourceFile,
      };
    }
    return {
      id: item.id,
      action: item.action,
      targetName: item.targetName,
      reason: item.reason,
      ...(item.replacementName ? { replacementName: item.replacementName } : {}),
    };
  }
}

export interface StagedClone {
  directory: string;
}
