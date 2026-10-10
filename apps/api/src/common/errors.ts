import type { ErrorCode } from '@hrms/shared';
import type { z } from 'zod';

/** An error that maps directly to an RFC 9457 problem+json response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string,
    readonly extras: {
      errors?: { path: string; message: string }[];
      meta?: Record<string, unknown>;
    } = {},
  ) {
    super(message ?? code);
  }

  static notFound(what = 'Resource'): ApiError {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }
  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }
  static versionConflict(): ApiError {
    return new ApiError(
      409,
      'VERSION_CONFLICT',
      'The record was changed by someone else. Reload and try again.',
    );
  }
  static validation(errors: { path: string; message: string }[], message = 'Validation failed') {
    return new ApiError(400, 'VALIDATION_FAILED', message, { errors });
  }
}

/** Validate untrusted input against a schema, throwing a 400 problem on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ApiError.validation(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function assertUuid(value: string, what = 'Resource'): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw ApiError.notFound(what);
  }
  return value;
}
