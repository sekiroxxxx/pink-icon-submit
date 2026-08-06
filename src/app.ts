import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { BatchService } from './batch-service.js';
import { AppError, isAppError } from './errors.js';
import type { CatalogGroup, CatalogPageInput, CreateBatchInput, CreateItemInput } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readItemPayload(request: FastifyRequest): Promise<{ item: CreateItemInput; svg?: Buffer }> {
  if (request.isMultipart()) {
    let item: CreateItemInput | undefined;
    let svg: Buffer | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'svg') {
          await part.toBuffer();
          continue;
        }
        svg = await part.toBuffer();
        continue;
      }
      if (part.fieldname === 'item') {
        try {
          item = JSON.parse(String(part.value)) as CreateItemInput;
        } catch {
          throw new AppError('REQUEST_INVALID', 'multipart item field must contain JSON.');
        }
      }
    }
    if (!item) {
      throw new AppError('REQUEST_INVALID', 'multipart request requires an item field.');
    }
    return { item, svg };
  }

  const body = request.body;
  if (!isObject(body)) {
    throw new AppError('REQUEST_INVALID', 'JSON request body must be an object.');
  }
  const item = (isObject(body.item) ? body.item : body) as unknown as CreateItemInput;
  const svgBase64 = body.svgBase64;
  if (svgBase64 !== undefined && typeof svgBase64 !== 'string') {
    throw new AppError('REQUEST_INVALID', 'svgBase64 must be a base64 string.');
  }
  return { item, ...(typeof svgBase64 === 'string' ? { svg: Buffer.from(svgBase64, 'base64') } : {}) };
}

function optionalQueryText(value: unknown, field: string, maximumLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AppError('REQUEST_INVALID', `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new AppError('REQUEST_INVALID', `${field} must be at most ${maximumLength} characters.`);
  }
  return normalized || undefined;
}

function requiredQueryText(value: unknown, field: string, maximumLength: number): string {
  const normalized = optionalQueryText(value, field, maximumLength);
  if (!normalized) {
    throw new AppError('REQUEST_INVALID', `${field} is required.`);
  }
  return normalized;
}

function positiveQueryInteger(value: unknown, field: string, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError('REQUEST_INVALID', `${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError('REQUEST_INVALID', `${field} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function catalogPageInput(query: unknown): CatalogPageInput {
  const parameters = isObject(query) ? query : {};
  const groupValue = parameters.group ?? 'all';
  if (typeof groupValue !== 'string' || !['all', 'pink', 'toolbar', 'common'].includes(groupValue)) {
    throw new AppError('REQUEST_INVALID', 'group must be all, pink, toolbar, or common.');
  }
  return {
    query: optionalQueryText(parameters.query, 'query', 100),
    group: groupValue as CatalogGroup,
    page: positiveQueryInteger(parameters.page, 'page', 1, 10_000),
    pageSize: positiveQueryInteger(parameters.pageSize, 'pageSize', 24, 48),
  };
}

export interface AppDependencies {
  batches: BatchService;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { files: 1, fileSize: dependencies.batches.uploadLimit } });

  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
      return reply.status(413).send({
        error: {
          code: 'UPLOAD_TOO_LARGE',
          message: `SVG upload exceeds ${dependencies.batches.uploadLimit} bytes.`,
        },
      });
    }
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unexpected server error.',
      },
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/catalog', async () => dependencies.batches.getCatalog());

  app.get('/api/catalog/page', async (request) => dependencies.batches.getCatalogPage(catalogPageInput(request.query)));

  app.get('/api/names/preview', async (request) => {
    const parameters = isObject(request.query) ? request.query : {};
    return dependencies.batches.previewName(requiredQueryText(parameters.name, 'name', 100));
  });

  app.get('/api/catalog/icons/:name/svg', async (request, reply) => {
    const { name } = request.params as { name: string };
    const svg = await dependencies.batches.getCatalogIconSvg(name);
    return reply.type('image/svg+xml; charset=utf-8').send(svg);
  });

  app.post('/api/batches', async (request, reply) => {
    const batch = await dependencies.batches.createBatch(request.body as CreateBatchInput);
    return reply.status(201).send(batch);
  });

  app.post('/api/batches/:batchId/items', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { item, svg } = await readItemPayload(request);
    const created = await dependencies.batches.addItem(batchId, item, svg);
    return reply.status(201).send(created);
  });

  app.put('/api/batches/:batchId/items/:itemId', async (request) => {
    const { batchId, itemId } = request.params as { batchId: string; itemId: string };
    const { item, svg } = await readItemPayload(request);
    return dependencies.batches.updateItem(batchId, itemId, item, svg);
  });

  app.delete('/api/batches/:batchId/items/:itemId', async (request, reply) => {
    const { batchId, itemId } = request.params as { batchId: string; itemId: string };
    await dependencies.batches.deleteItem(batchId, itemId);
    return reply.status(204).send();
  });

  app.post('/api/batches/:batchId/validate', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.validateBatch(batchId);
  });

  app.post('/api/batches/:batchId/submit', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.submit(batchId);
  });

  app.get('/api/batches/:batchId', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.getBatch(batchId);
  });

  app.post('/api/batches/:batchId/retry', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.retry(batchId);
  });

  return app;
}
