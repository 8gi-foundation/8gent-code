/**
 * Structured error classes with typed codes, metadata, and serialization.
 * Designed for consistent error handling across the 8gent ecosystem.
 */

export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "RATE_LIMITED";

export interface AppErrorJSON {
  name: string;
  message: string;
  code: ErrorCode;
  statusCode: number;
  isOperational: boolean;
  metadata?: Record<string, unknown>;
  stack?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    isOperational = true,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.metadata = metadata;
    // Preserve proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): AppErrorJSON {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      isOperational: this.isOperational,
      metadata: this.metadata,
      stack: this.stack,
    };
  }

  static fromJSON(json: AppErrorJSON): AppError {
    const err = new AppError(
      json.message,
      json.code,
      json.statusCode,
      json.isOperational,
      json.metadata
    );
    err.name = json.name;
    if (json.stack) {
      err.stack = json.stack;
    }
    return err;
  }
}

export class NotFoundError extends AppError {
  constructor(
    resource: string,
    id?: string | number,
    metadata?: Record<string, unknown>
  ) {
    const msg = id
      ? `${resource} with id '${id}' not found`
      : `${resource} not found`;
    super(msg, "NOT_FOUND", 404, true, { resource, id, ...metadata });
  }
}

export class ValidationError extends AppError {
  readonly fields?: Record<string, string[]>;

  constructor(
    message: string,
    fields?: Record<string, string[]>,
    metadata?: Record<string, unknown>
  ) {
    super(message, "VALIDATION_FAILED", 400, true, { fields, ...metadata });
    this.fields = fields;
  }
}

export class TimeoutError extends AppError {
  constructor(
    operation: string,
    limitMs: number,
    metadata?: Record<string, unknown>
  ) {
    super(
      `Operation '${operation}' timed out after ${limitMs}ms`,
      "TIMEOUT",
      408,
      true,
      { operation, limitMs, ...metadata }
    );
  }
}

export class AuthError extends AppError {
  constructor(
    message = "Authentication required",
    metadata?: Record<string, unknown>
  ) {
    super(message, "UNAUTHORIZED", 401, true, metadata);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    action?: string,
    metadata?: Record<string, unknown>
  ) {
    const msg = action
      ? `Forbidden: you do not have permission to ${action}`
      : "Forbidden";
    super(msg, "FORBIDDEN", 403, true, { action, ...metadata });
  }
}

/** Returns true if err is an AppError that is operational (expected). */
export function isOperationalError(err: unknown): err is AppError {
  return err instanceof AppError && err.isOperational;
}
