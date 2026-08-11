import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AuthService, sessionCookieName, sessionMaxAgeSeconds } from './auth.js';
import { BatchService } from './batch-service.js';
import { AppError, isAppError } from './errors.js';
import type { AuthenticatedUser, CatalogGroup, CatalogPageInput, CreateBatchInput, CreateItemInput } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser?: AuthenticatedUser;
  }
}

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

function batchListLimit(query: unknown): number {
  const parameters = isObject(query) ? query : {};
  return positiveQueryInteger(parameters.limit, 'limit', 20, 20);
}

function submitConfirmation(body: unknown): boolean {
  if (body === undefined || body === null) {
    return false;
  }
  if (!isObject(body) || (body.confirmRepeatedSubmission !== undefined && typeof body.confirmRepeatedSubmission !== 'boolean')) {
    throw new AppError('REQUEST_INVALID', 'confirmRepeatedSubmission must be a boolean when provided.');
  }
  return body.confirmRepeatedSubmission === true;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url;
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const [key, ...rest] = entry.trim().split('=');
    if (key !== name) continue;
    const value = rest.join('=');
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionCookie(token: string, secureCookie: boolean): string {
  const secure = secureCookie ? '; Secure' : '';
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secure}`;
}

function expiredSessionCookie(secureCookie: boolean): string {
  const secure = secureCookie ? '; Secure' : '';
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function isMutation(request: FastifyRequest): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
}

function assertSameOriginWhenPresent(request: FastifyRequest, publicOrigin?: string): void {
  const header = request.headers.origin;
  if (header === undefined) return;
  const origin = Array.isArray(header) ? header[0] : header;
  const host = request.headers.host;
  if (!origin || !host) {
    throw new AppError('CSRF_ORIGIN_INVALID', '请求来源无效，请从当前服务页面重新提交。', 403);
  }
  try {
    const expected = publicOrigin ?? new URL(`${request.protocol}://${host}`).origin;
    if (new URL(origin).origin !== expected || new URL(origin).origin !== origin) {
      throw new AppError('CSRF_ORIGIN_INVALID', '请求来源无效，请从当前服务页面重新提交。', 403);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CSRF_ORIGIN_INVALID', '请求来源无效，请从当前服务页面重新提交。', 403);
  }
}

function authenticatedUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.authenticatedUser) {
    throw new AppError('AUTHENTICATION_REQUIRED', '请先登录后再继续。', 401);
  }
  return request.authenticatedUser;
}

function submitterFor(user: AuthenticatedUser): CreateBatchInput['submitter'] {
  const [name] = user.username.split('@');
  return { name: name || user.username, email: user.username };
}

export interface AppDependencies {
  batches: BatchService;
  auth: AuthService;
  sessionCookieSecure?: boolean;
  publicOrigin?: string;
  readiness?: () => void | Promise<void>;
  logger?: boolean;
  webRoot?: string;
  requireWebRoot?: boolean;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false });
  await app.register(multipart, { limits: { files: 1, fileSize: dependencies.batches.uploadLimit } });

  if (dependencies.webRoot) {
    let webBuildAvailable = false;
    try {
      await access(join(dependencies.webRoot, 'index.html'));
      webBuildAvailable = true;
    } catch (error) {
      if (dependencies.requireWebRoot) {
        throw new Error(`Production web build is missing at ${dependencies.webRoot}. Run npm run build before npm start.`, { cause: error });
      }
    }
    if (webBuildAvailable) {
      await app.register(fastifyStatic, {
        root: dependencies.webRoot,
        index: false,
      });
      const sendSpa = async (_request: FastifyRequest, reply: FastifyReply) => reply.sendFile('index.html');
      app.get('/', sendSpa);
      app.get('/workbench', sendSpa);
    }
  } else if (dependencies.requireWebRoot) {
    throw new Error('Production web build path is required.');
  }

  app.setErrorHandler((error, request, reply) => {
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
    const errorId = randomUUID();
    request.log.error({ err: error, errorId }, 'Unhandled request error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时无法完成请求，请稍后重试。',
        errorId,
      },
    });
  });

  app.addHook('preHandler', async (request) => {
    const path = requestPath(request);
    const isPublic = (request.method === 'GET' && (path === '/api/health' || path === '/api/ready'))
      || (request.method === 'POST' && path === '/api/auth/login');
    if (!path.startsWith('/api/')) return;
    if (isMutation(request)) {
      assertSameOriginWhenPresent(request, dependencies.publicOrigin);
    }
    if (isPublic) return;
    const user = dependencies.auth.authenticate(cookieValue(request, sessionCookieName));
    if (!user) {
      throw new AppError('AUTHENTICATION_REQUIRED', '请先登录后再继续。', 401);
    }
    request.authenticatedUser = user;
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/ready', async (_request, reply) => {
    try {
      await dependencies.readiness?.();
      return { status: 'ready' };
    } catch (error) {
      app.log.warn({ err: error }, 'Readiness check failed');
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const session = await dependencies.auth.login(request.body);
    return reply.header('set-cookie', sessionCookie(session.token, dependencies.sessionCookieSecure === true)).send({ user: session.user });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    dependencies.auth.logout(cookieValue(request, sessionCookieName));
    return reply.header('set-cookie', expiredSessionCookie(dependencies.sessionCookieSecure === true)).status(204).send();
  });

  app.get('/api/auth/me', async (request) => ({ user: authenticatedUser(request) }));

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

  app.get('/api/batches', async (request) => dependencies.batches.listBatches(batchListLimit(request.query), authenticatedUser(request).id));

  app.get('/api/batches/active', async (request, reply) => {
    const active = dependencies.batches.getActiveBatch(authenticatedUser(request).id);
    return active ? reply.send(active) : reply.status(204).send();
  });

  app.post('/api/batches', async (request, reply) => {
    const user = authenticatedUser(request);
    const batch = await dependencies.batches.createBatch({
      ...(request.body as Omit<CreateBatchInput, 'submitter'>),
      submitter: submitterFor(user),
    }, user.id);
    return reply.status(201).send(batch);
  });

  app.put('/api/batches/:batchId', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.updateBatch(batchId, request.body as Pick<CreateBatchInput, 'title' | 'description' | 'designUrl'>, authenticatedUser(request).id);
  });

  app.post('/api/batches/:batchId/items', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { item, svg } = await readItemPayload(request);
    const created = await dependencies.batches.addItem(batchId, item, svg, authenticatedUser(request).id);
    return reply.status(201).send(created);
  });

  app.put('/api/batches/:batchId/items/:itemId', async (request) => {
    const { batchId, itemId } = request.params as { batchId: string; itemId: string };
    const { item, svg } = await readItemPayload(request);
    return dependencies.batches.updateItem(batchId, itemId, item, svg, authenticatedUser(request).id);
  });

  app.delete('/api/batches/:batchId/items/:itemId', async (request, reply) => {
    const { batchId, itemId } = request.params as { batchId: string; itemId: string };
    await dependencies.batches.deleteItem(batchId, itemId, authenticatedUser(request).id);
    return reply.status(204).send();
  });

  app.post('/api/batches/:batchId/validate', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.validateBatch(batchId, authenticatedUser(request).id);
  });

  app.post('/api/batches/:batchId/submit', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return await dependencies.batches.submit(batchId, submitConfirmation(request.body), authenticatedUser(request).id);
  });

  app.post('/api/batches/:batchId/return-to-edit', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return await dependencies.batches.returnToEdit(batchId, authenticatedUser(request).id);
  });

  app.post('/api/batches/:batchId/clone', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const cloned = await dependencies.batches.cloneBatch(batchId, authenticatedUser(request).id);
    return reply.status(201).send(cloned);
  });

  app.get('/api/batches/:batchId', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return dependencies.batches.getBatch(batchId, authenticatedUser(request).id);
  });

  app.post('/api/batches/:batchId/retry', async (request) => {
    const { batchId } = request.params as { batchId: string };
    return await dependencies.batches.retry(batchId, authenticatedUser(request).id);
  });

  return app;
}
