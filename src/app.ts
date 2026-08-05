import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { BatchService } from './batch-service.js';
import { AppError, isAppError } from './errors.js';
import type { CreateBatchInput, CreateItemInput } from './types.js';

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
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unexpected server error.',
      },
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/catalog', async () => dependencies.batches.getCatalog());

  app.post('/api/batches', async (request, reply) => {
    const batch = dependencies.batches.createBatch(request.body as CreateBatchInput);
    return reply.status(201).send(batch);
  });

  app.post('/api/batches/:batchId/items', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { item, svg } = await readItemPayload(request);
    const created = await dependencies.batches.addItem(batchId, item, svg);
    return reply.status(201).send(created);
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
