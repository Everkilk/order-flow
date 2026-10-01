import { ZodError } from 'zod';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

export const logger = pino({ redact: ['req.headers.cookie', 'req.headers.authorization', 'password', 'token'] });

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  const start = performance.now();
  res.on('finish', () => logger.info({ requestId: id, method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(performance.now() - start) }, 'request'));
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Resource not found.'));

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred.';
  let fields: Record<string, string> | undefined;
  if (error instanceof AppError) {
    ({ status, code, message, fields } = error);
  } else if (error instanceof ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid request.';
    fields = Object.fromEntries(error.issues.map(i => [i.path.join('.'), i.message]));
  } else if (error && typeof error === 'object' && 'code' in error) {
    const dbCode = String(error.code);
    logger.warn({ err: error, requestId: res.locals.requestId }, 'database rejected request');
    if (dbCode === '23505') { status = 409; code = 'DUPLICATE_VALUE'; message = 'A value already exists.'; }
    else if (dbCode === '23503') { status = 422; code = 'INVALID_REFERENCE'; message = 'A referenced record does not exist.'; }
    else if (dbCode === '23514' || dbCode === '23502') { status = 422; code = 'BUSINESS_RULE'; message = 'The requested value violates a business rule.'; }
    else if (dbCode === '22003' || dbCode === '22P02' || dbCode === '22007') {
      status = 400; code = 'VALIDATION_ERROR'; message = 'A numeric, identifier, or date value is invalid.';
    }
  }
  if (status >= 500) logger.error({ err: error, requestId: res.locals.requestId }, 'request failed');
  res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}), requestId: res.locals.requestId } });
};
