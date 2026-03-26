/**
 * Represents a CORS policy configuration.
 */
export class CorsPolicy {
  /**
   * @param allowedOrigins - List of allowed origins (including wildcards)
   * @param allowedMethods - List of allowed HTTP methods
   * @param allowedHeaders - List of allowed headers
   * @param maxAge - Max age for preflight response (in seconds)
   */
  constructor(
    public allowedOrigins: string[],
    public allowedMethods: string[],
    public allowedHeaders: string[],
    public maxAge?: number
  ) {}

  /**
   * Check if a request is allowed based on origin and method.
   * @param origin - Request origin
   * @param method - Request method
   * @returns True if allowed
   */
  isAllowed(origin: string, method: string): boolean {
    const originAllowed = this.allowedOrigins.includes('*') || this.allowedOrigins.includes(origin);
    const methodAllowed = this.allowedMethods.includes(method);
    return originAllowed && methodAllowed;
  }

  /**
   * Build CORS response headers.
   * @param origin - Request origin
   * @param method - Request method
   * @returns CORS headers object
   */
  buildHeaders(origin: string, method: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.allowedOrigins.includes('*')) {
      headers['Access-Control-Allow-Origin'] = '*';
    } else {
      headers['Access-Control-Allow-Origin'] = origin;
    }
    headers['Access-Control-Allow-Methods'] = this.allowedMethods.join(', ');
    headers['Access-Control-Allow-Headers'] = this.allowedHeaders.join(', ');
    if (this.maxAge !== undefined) {
      headers['Access-Control-Max-Age'] = this.maxAge.toString();
    }
    return headers;
  }
}

/**
 * Check if a request is a preflight request.
 * @param method - HTTP method
 * @param headers - Request headers
 * @returns True if preflight
 */
export function isPreflightRequest(method: string, headers: { [key: string]: string }): boolean {
  return method === 'OPTIONS' && headers['Access-Control-Request-Method'] !== undefined && headers['Access-Control-Request-Headers'] !== undefined;
}