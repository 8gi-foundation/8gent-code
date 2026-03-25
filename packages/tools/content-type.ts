/**
 * Parse a Content-Type header into type and parameters.
 * @param header - The Content-Type header string.
 * @returns An object with type and params.
 */
export function parse(header: string): { type: string; params: Record<string, string> } {
  const [typePart, ...paramParts] = header.split(';').map(s => s.trim());
  const type = typePart.split('/').map(s => s.toLowerCase()).join('/');
  const params: Record<string, string> = {};
  for (const param of paramParts) {
    const [key, value] = param.split('=').map(s => s.trim());
    if (key && value) {
      params[key.toLowerCase()] = value;
    }
  }
  return { type, params };
}

/**
 * Format a media type and parameters into a Content-Type header string.
 * @param type - The media type.
 * @param params - Optional parameters.
 * @returns The formatted Content-Type header.
 */
export function format(type: string, params?: Record<string, string>): string {
  const parts = [type];
  if (params) {
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
    parts.push(...sortedParams);
  }
  return parts.join('; ');
}

/**
 * Extract the charset parameter from a Content-Type header.
 * @param header - The Content-Type header string.
 * @returns The charset value or undefined.
 */
export function charset(header: string): string | undefined {
  const { params } = parse(header);
  return params['charset'];
}

/**
 * Check if a Content-Type header indicates JSON.
 * @param header - The Content-Type header string.
 * @returns True if JSON, false otherwise.
 */
export function isJSON(header: string): boolean {
  const { type } = parse(header);
  return type === 'application/json';
}

/**
 * Check if a Content-Type header indicates HTML.
 * @param header - The Content-Type header string.
 * @returns True if HTML, false otherwise.
 */
export function isHTML(header: string): boolean {
  const { type } = parse(header);
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/**
 * Check if a Content-Type header indicates text.
 * @param header - The Content-Type header string.
 * @returns True if text, false otherwise.
 */
export function isText(header: string): boolean {
  const { type } = parse(header);
  return type.startsWith('text/');
}