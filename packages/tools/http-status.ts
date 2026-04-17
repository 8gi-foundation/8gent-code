/**
 * HTTP status code constants and classification helpers.
 * RFC 9110 compliant.
 */

// 1xx Informational
export const CONTINUE = 100;
export const SWITCHING_PROTOCOLS = 101;
export const PROCESSING = 102;
export const EARLY_HINTS = 103;

// 2xx Success
export const OK = 200;
export const CREATED = 201;
export const ACCEPTED = 202;
export const NO_CONTENT = 204;
export const PARTIAL_CONTENT = 206;

// 3xx Redirection
export const MOVED_PERMANENTLY = 301;
export const FOUND = 302;
export const SEE_OTHER = 303;
export const NOT_MODIFIED = 304;
export const TEMPORARY_REDIRECT = 307;
export const PERMANENT_REDIRECT = 308;

// 4xx Client Error
export const BAD_REQUEST = 400;
export const UNAUTHORIZED = 401;
export const FORBIDDEN = 403;
export const NOT_FOUND = 404;
export const METHOD_NOT_ALLOWED = 405;
export const CONFLICT = 409;
export const GONE = 410;
export const UNPROCESSABLE_ENTITY = 422;
export const TOO_MANY_REQUESTS = 429;

// 5xx Server Error
export const INTERNAL_SERVER_ERROR = 500;
export const NOT_IMPLEMENTED = 501;
export const BAD_GATEWAY = 502;
export const SERVICE_UNAVAILABLE = 503;
export const GATEWAY_TIMEOUT = 504;

// Classification helpers

/** True for 2xx codes. */
export function isSuccess(code: number): boolean {
  return code >= 200 && code < 300;
}

/** True for 3xx codes. */
export function isRedirect(code: number): boolean {
  return code >= 300 && code < 400;
}

/** True for 4xx codes. */
export function isClientError(code: number): boolean {
  return code >= 400 && code < 500;
}

/** True for 5xx codes. */
export function isServerError(code: number): boolean {
  return code >= 500 && code < 600;
}

/** True for 4xx or 5xx codes. */
export function isError(code: number): boolean {
  return isClientError(code) || isServerError(code);
}

/** True for 1xx codes. */
export function isInformational(code: number): boolean {
  return code >= 100 && code < 200;
}

const STATUS_TEXT: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Returns the standard reason phrase for a given HTTP status code.
 * Returns "Unknown Status" for unrecognized codes.
 */
export function statusText(code: number): string {
  return STATUS_TEXT[code] ?? "Unknown Status";
}
