/**
 * Error code metadata interface.
 */
interface ErrorCode {
  message: string;
  httpStatus: number;
}

/**
 * Error code registry mapping codes to messages and HTTP status codes.
 */
const errorCodeRegistry: Record<string, ErrorCode> = {};

/**
 * Custom error class with typed error code.
 */
class AppError extends Error {
  code: string;
  message: string;
  httpStatus: number;
  detail?: string;

  constructor(code: string, message: string, httpStatus: number, detail?: string) {
    super(message);
    this.code = code;
    this.message = message;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

/**
 * Creates an AppError instance with the given code and optional detail.
 * @param code - The error code registered in errorCodeRegistry.
 * @param detail - Optional additional detail message.
 * @returns A new AppError instance.
 */
function create(code: string, detail?: string): AppError {
  const { message, httpStatus } = errorCodeRegistry[code];
  return new AppError(code, message, httpStatus, detail);
}

/**
 * Type guard to check if an object is an AppError.
 * @param err - The error object to check.
 * @returns True if the object is an AppError.
 */
function isAppError(err: any): err is AppError {
  return err instanceof AppError;
}

/**
 * Serializes an AppError to a plain object for transmission.
 * @param err - The AppError instance to serialize.
 * @returns A serializable object with error details.
 */
function toJSON(err: AppError): { code: string; message: string; httpStatus: number; detail?: string } {
  return {
    code: err.code,
    message: err.message,
    httpStatus: err.httpStatus,
    detail: err.detail,
  };
}

export { AppError, create, isAppError, toJSON, errorCodeRegistry };