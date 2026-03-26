/**
 * Analyzes headers for clickjacking protection status
 * @param headers - HTTP headers object
 * @returns Analysis result with protection status and issues
 */
export function analyze(headers: { [key: string]: string | undefined }): {
  protected: boolean;
  method: 'XFO' | 'CSP' | 'none';
  issues: string[];
} {
  const issues: string[] = [];
  let method = 'none';
  let protectedStatus = false;

  if (headers['X-Frame-Options']) {
    const xfoResult = checkXFO(headers['X-Frame-Options']);
    if (xfoResult) {
      method = 'XFO';
      protectedStatus = xfoResult === 'DENY';
      if (xfoResult !== 'DENY' && xfoResult !== 'SAMEORIGIN') {
        issues.push(`Invalid X-Frame-Options: ${xfoResult}`);
      }
    }
  }

  if (headers['Content-Security-Policy']) {
    const cspResult = checkCSPFrameAncestors(headers['Content-Security-Policy']);
    if (cspResult) {
      method = 'CSP';
      protectedStatus = cspResult === 'none';
      if (cspResult !== 'none') {
        issues.push(`Weak CSP frame-ancestors: ${cspResult}`);
      }
    }
  }

  return { protected: protectedStatus, method, issues };
}

/**
 * Validates X-Frame-Options header value
 * @param value - X-Frame-Options header value
 * @returns 'DENY' | 'SAMEORIGIN' | invalid value
 */
export function checkXFO(value: string): 'DENY' | 'SAMEORIGIN' | string {
  return value.trim() === 'DENY' ? 'DENY' : value.trim() === 'SAMEORIGIN' ? 'SAMEORIGIN' : value;
}

/**
 * Parses CSP frame-ancestors directive
 * @param csp - Content-Security-Policy header value
 * @returns 'none' | 'self' | allowed domain | undefined
 */
export function checkCSPFrameAncestors(csp: string): 'none' | 'self' | string | undefined {
  const frameAncestors = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (!frameAncestors) return undefined;
  const value = frameAncestors[1].trim();
  return value === 'none' ? 'none' : value === 'self' ? 'self' : value;
}

/**
 * Generates markdown report from analysis
 * @param analysis - Result from analyze()
 * @returns Markdown report string
 */
export function renderReport(analysis: { protected: boolean; method: string; issues: string[] }): string {
  return `# Clickjacking Protection Report\n\n**Protected:** ${analysis.protected ? 'Yes' : 'No'}\n**Method:** ${analysis.method}\n\n## Issues\n${analysis.issues.map(i => `- ${i}`).join('\n')}\n\n## Recommendations\n- If not protected: Set X-Frame-Options to 'DENY' or CSP frame-ancestors to 'none'\n- Avoid 'SAMEORIGIN' or 'self' unless strictly necessary`;
}