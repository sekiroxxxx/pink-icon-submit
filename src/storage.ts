import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
