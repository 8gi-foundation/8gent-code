/**
 * Parse a URL string into its components.
 * @param url - The URL string to parse.
 * @returns An object containing the URL's components.
 */
function parseUrl(url: string): { protocol: string; host: string; port?: string; path: string; query: string; hash: string } {
  const urlObj = new URL(url);
  const hostParts = urlObj.host.split(':');
  const host = hostParts[0];
  const port = hostParts.length > 1 ? hostParts[1] : undefined;
  return {
    protocol: urlObj.protocol.replace(':', ''),
    host,
    port,
    path: urlObj.pathname,
    query: urlObj.search.slice(1),
    hash: urlObj.hash.slice(1)
  };
}

/**
 * Build a URL string from its components.
 * @param parts - The URL components to assemble.
 * @returns The assembled URL string.
 */
function buildUrl(parts: { protocol: string; host: string; port?: string; path: string; query?: string; hash?: string }): string {
  let url = `${parts.protocol}://${parts.host}`;
  if (parts.port) url += `:${parts.port}`;
  url += parts.path;
  if (parts.query) url += `?${parts.query}`;
  if (parts.hash) url += `#${parts.hash}`;
  return url;
}

/**
 * Parse a query string into a record of key-value pairs.
 * @param qs - The query string to parse.
 * @returns A record of key-value pairs.
 */
function parseQueryString(qs: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  const pairs = qs.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key in params) {
      if (Array.isArray(params[key])) {
        (params[key] as string[]).push(value);
      } else {
        params[key] = [params[key] as string, value];
      }
    } else {
      params[key] = value;
    }
  }
  return params;
}

/**
 * Convert a record of key-value pairs into a query string.
 * @param params - The key-value pairs to convert.
 * @returns The query string.
 */
function stringifyQuery(params: Record<string, string | string[]>): string {
  const entries: string[] = [];
  for (const key in params) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const v of value) {
        entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    } else {
      entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return entries.join('&');
}

/**
 * Add a query parameter to a record.
 * @param params - The record to modify.
 * @param key - The parameter key.
 * @param value - The parameter value.
 */
function addQueryParam(params: Record<string, string | string[]>, key: string, value: string): void {
  if (key in params) {
    if (Array.isArray(params[key])) {
      (params[key] as string[]).push(value);
    } else {
      params[key] = [params[key] as string, value];
    }
  } else {
    params[key] = value;
  }
}

/**
 * Remove a query parameter from a record.
 * @param params - The record to modify.
 * @param key - The parameter key to remove.
 */
function removeQueryParam(params: Record<string, string | string[]>, key: string): void {
  delete params[key];
}

export { parseUrl, buildUrl, parseQueryString, stringifyQuery, addQueryParam, removeQueryParam };