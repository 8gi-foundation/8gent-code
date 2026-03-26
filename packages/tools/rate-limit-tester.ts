/**
 * Returns list of bypass techniques
 */
export function techniques(): string[] {
  return ['IP rotation', 'Header spoofing', 'Path variation'];
}

/**
 * Detects rate limit header patterns
 * @param headers - HTTP headers object
 * @returns Object with detected headers and bypass surface
 */
export function analyzeHeaders(headers: Record<string, string>): { detectedHeaders: string[], bypassSurface: string[] } {
  const detected = [];
  const surface = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('X-RateLimit-')) {
      detected.push(key);
      if (key.includes('Limit')) surface.push('Header spoofing');
      if (key.includes('Reset')) surface.push('Timing attack');
    } else if (key === 'Retry-After') {
      detected.push(key);
      surface.push('Rate delay');
    }
  }
  return { detectedHeaders: [...new Set(detected)], bypassSurface: [...new Set(surface)] };
}

/**
 * Extracts rate limit values from headers
 * @param headers - HTTP headers object
 * @returns Object with limit, remaining, reset, retryAfter values
 */
export function parseRateLimitHeaders(headers: Record<string, string>): { limit: number | null, remaining: number | null, reset: number | null, retryAfter: number | null } {
  return {
    limit: headers['X-RateLimit-Limit'] ? parseInt(headers['X-RateLimit-Limit']) : null,
    remaining: headers['X-RateLimit-Remaining'] ? parseInt(headers['X-RateLimit-Remaining']) : null,
    reset: headers['X-RateLimit-Reset'] ? parseInt(headers['X-RateLimit-Reset']) : null,
    retryAfter: headers['Retry-After'] ? parseInt(headers['Retry-After']) : null
  };
}

/**
 * Generates markdown report from analysis
 * @param analysis - Combined analysis object with headers and rate limit data
 * @returns Markdown report string
 */
export function renderReport(analysis: { detectedHeaders: string[], bypassSurface: string[], limit: number | null, remaining: number | null, reset: number | null, retryAfter: number | null }): string {
  return `# Rate Limit Bypass Report\n\n**Detected Headers:** ${analysis.detectedHeaders.join(', ')}\n\n**Bypass Surface:** ${analysis.bypassSurface.join(', ')}\n\n**Rate Limit Info:**\n- Limit: ${analysis.limit}\n- Remaining: ${analysis.remaining}\n- Reset: ${analysis.reset}\n- Retry-After: ${analysis.retryAfter}`;
}