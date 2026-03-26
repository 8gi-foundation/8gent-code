/**
 * Check if the URL is absolute (has a scheme).
 * @param url - The URL to check.
 * @returns True if the URL is absolute, false otherwise.
 */
export function isAbsolute(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol !== '';
  } catch {
    return false;
  }
}

/**
 * Check if the URL has one of the allowed protocols.
 * @param url - The URL to check.
 * @param protocols - Allowed protocols (e.g., 'http', 'https').
 * @returns True if the URL's protocol is in the allowed list, false otherwise.
 */
export function hasProtocol(url: string, ...protocols: string[]): boolean {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.slice(0, -1);
    return protocols.includes(protocol);
  } catch {
    return false;
  }
}

/**
 * Check if the URL is a safe redirect (hostname is in allowedHosts).
 * @param url - The URL to check.
 * @param allowedHosts - Hostnames that are considered safe.
 * @returns True if the hostname is in allowedHosts, false otherwise.
 */
export function isSafeRedirect(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url);
    return allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Validate the URL with configurable protocol and hostname rules.
 * @param url - The URL to validate.
 * @returns Object with `ok` indicating success and `reason` if validation fails.
 */
export function validate(url: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (!isAbsolute(url)) {
      return { ok: false, reason: 'Not absolute' };
    }
    if (!hasProtocol(url, 'http', 'https')) {
      return { ok: false, reason: 'Invalid protocol' };
    }
    if (!isSafeRedirect(url, ['example.com'])) {
      return { ok: false, reason: 'Unsafe redirect' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'Invalid URL' };
  }
}