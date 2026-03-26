/**
 * Parses a Set-Cookie header into name, value, and flags.
 * @param setCookieHeader - The Set-Cookie header string.
 * @returns Parsed cookie object.
 */
function parseCookie(setCookieHeader: string): { name: string; value: string; flags: { httpOnly: boolean; secure: boolean; sameSite?: string; path?: string; maxAge?: string } } {
  const [nameValuePart, ...flagParts] = setCookieHeader.split(';').map(part => part.trim());
  const [name, value] = nameValuePart.split('=').map(part => part.trim());
  const flags = {
    httpOnly: false,
    secure: false,
    sameSite: undefined,
    path: undefined,
    maxAge: undefined
  };
  for (const part of flagParts) {
    if (part === 'HttpOnly') {
      flags.httpOnly = true;
    } else if (part === 'Secure') {
      flags.secure = true;
    } else {
      const [key, val] = part.split('=', 2);
      if (key === 'SameSite') {
        flags.sameSite = val;
      } else if (key === 'Path') {
        flags.path = val;
      } else if (key === 'Max-Age') {
        flags.maxAge = val;
      }
    }
  }
  return { name, value, flags };
}

/**
 * Audits a parsed cookie for missing security flags.
 * @param cookie - Parsed cookie object.
 * @returns Audit results with issues and score.
 */
function audit(cookie: ReturnType<typeof parseCookie>): { issues: string[]; score: number } {
  const issues: string[] = [];
  if (!cookie.flags.httpOnly) issues.push('Missing HttpOnly flag');
  if (!cookie.flags.secure) issues.push('Missing Secure flag');
  if (cookie.flags.sameSite === undefined) issues.push('Missing SameSite attribute');
  if (cookie.flags.path === undefined) issues.push('Missing Path attribute');
  if (cookie.flags.maxAge === undefined) issues.push('Missing Max-Age attribute');
  const score = 5 - issues.length;
  return { issues, score };
}

/**
 * Scans all Set-Cookie headers in a response for security issues.
 * @param headers - Array of HTTP headers.
 * @returns Array of audit results per cookie.
 */
function scanHeaders(headers: string[]): Array<{ name: string; issues: string[]; score: number }> {
  return headers
    .filter(header => header.startsWith('Set-Cookie'))
    .map(header => {
      const parsed = parseCookie(header);
      return { name: parsed.name, ...audit(parsed) };
    });
}

/**
 * Renders a markdown security report from audit results.
 * @param results - Array of audit results.
 * @returns Markdown-formatted security report.
 */
function renderReport(results: ReturnType<typeof scanHeaders>): string {
  let report = '# Cookie Security Report\n\n';
  for (const result of results) {
    report += `## Cookie: ${result.name}\n\n`;
    report += '- Issues: ' + result.issues.join(', ') + '\n';
    report += `- Score: ${result.score}/5\n\n`;
  }
  return report;
}

export { parseCookie, audit, scanHeaders, renderReport };