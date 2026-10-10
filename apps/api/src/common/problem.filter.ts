import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorCode, ProblemDetails } from '@hrms/shared';
import { ApiError } from './errors.js';
import { requestContext } from './request-context.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** PostgreSQL error codes mapped to safe client responses. */
function fromPg(err: { code?: string; constraint?: string }): ApiError | null {
  switch (err.code) {
    case '23505':
      return ApiError.conflict('A record with the same unique value already exists');
    case '23P01':
      return ApiError.conflict('The period overlaps an existing record');
    case '23503':
      return ApiError.conflict('The record is referenced by, or references, another record');
    case '23514':
      return ApiError.validation([{ path: err.constraint ?? '', message: 'Constraint violated' }]);
    case '42501':
      // Insufficient privilege, including RLS WITH CHECK violations.
      return ApiError.forbidden();
    default:
      return null;
  }
}

function findPgError(err: unknown): { code?: string; constraint?: string } | null {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return c as { code: string };
    cur = c.cause;
  }
  return null;
}

/** Every error becomes RFC 9457 problem+json; internals are never leaked. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let err: ApiError;
    if (exception instanceof ApiError) {
      err = exception;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === 404 ? 'NOT_FOUND' : status === 413 ? 'VALIDATION_FAILED' : status === 400 ? 'VALIDATION_FAILED' : 'INTERNAL';
      err = new ApiError(status, code, status === 404 ? 'Not found' : exception.message);
    } else {
      const pgErr = findPgError(exception);
      const mapped = pgErr ? fromPg(pgErr) : null;
      if (mapped) {
        err = mapped;
      } else {
        const ctx = requestContext.get();
        this.logger.error(
          `Unhandled error (request ${ctx?.requestId ?? '-'}): ${(exception as Error)?.stack ?? String(exception)}`,
        );
        err = new ApiError(500, 'INTERNAL', 'An unexpected error occurred');
      }
    }
    const body: ProblemDetails = {
      type: `https://hrms.local/problems/${err.code.toLowerCase()}`,
      title: TITLES[err.status] ?? 'Error',
      status: err.status,
      code: err.code,
      detail: err.message,
      ...(err.extras.errors ? { errors: err.extras.errors } : {}),
      ...(err.extras.meta ? { meta: err.extras.meta } : {}),
    };
    if (!res.headersSent) {
      res.status(err.status).type('application/problem+json').send(JSON.stringify(body));
    }
  }
}
