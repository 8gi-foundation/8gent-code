/**
 * Converts an object to a URL query string.
 * @param obj - The object to encode.
 * @returns The query string.
 */
export function stringify(obj: Record<string, any>): string {
  return Object.entries(obj)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map(val => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`).join('&');
      } else {
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
    })
    .join('&');
}

/**
 * Parses a URL query string into a typed object.
 * @param search - The query string to parse.
 * @returns The parsed object.
 */
export function parse(search: string): Record<string, any> {
  const params: Record<string, any> = {};
  const pairs = search.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    const decodedKey = decodeURIComponent(key);
    const decodedValue = decodeURIComponent(value || '');
    if (!params[decodedKey]) {
      params[decodedKey] = [];
    }
    params[decodedKey].push(decodedValue);
  }
  for (const key in params) {
    params[key] = params[key].map(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      const num = Number(val);
      if (!isNaN(num)) return num;
      return val;
    });
  }
  return params;
}