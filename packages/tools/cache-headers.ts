/**
 * Represents parsed Cache-Control header directives.
 */
export class CacheControl {
  /**
   * Maximum age in seconds for which the resource is fresh.
   */
  maxAge?: number;

  /**
   * Whether the cache must revalidate the resource before reuse.
   */
  mustRevalidate?: boolean;
}

/**
 * Parses a Cache-Control header string into a CacheControl object.
 * @param headerValue - The Cache-Control header value.
 * @returns Parsed CacheControl object.
 */
export function parse(headerValue: string): CacheControl {
  const cc = new CacheControl();
  const parts = headerValue.split(/;\s*/);
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 'max-age') {
      cc.maxAge = parseInt(value, 10);
    } else if (key === 'must-revalidate') {
      cc.mustRevalidate = true;
    }
  }
  return cc;
}

/**
 * Builds a Cache-Control header string from options.
 * @param options - Options to build the header.
 * @returns Cache-Control header string.
 */
export function build(options: { maxAge?: number; mustRevalidate?: boolean }): string {
  const parts: string[] = [];
  if (options.maxAge !== undefined) {
    parts.push(`max-age=${options.maxAge}`);
  }
  if (options.mustRevalidate) {
    parts.push('must-revalidate');
  }
  return parts.join('; ');
}

/**
 * Checks if a resource is stale based on its age and Cache-Control directives.
 * @param cc - CacheControl object.
 * @param age - Current age of the resource.
 * @returns True if the resource is stale.
 */
export function isStale(cc: CacheControl, age: number): boolean {
  return cc.maxAge !== undefined && age > cc.maxAge;
}

/**
 * Checks if the Cache-Control directives require revalidation.
 * @param cc - CacheControl object.
 * @returns True if revalidation is required.
 */
export function mustRevalidate(cc: CacheControl): boolean {
  return cc.mustRevalidate === true;
}

export { CacheControl, parse, build, isStale, mustRevalidate };