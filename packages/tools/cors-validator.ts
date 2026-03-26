/**
 * Represents a CORS policy violation with severity and suggestions.
 */
interface Violation {
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

/**
 * Validates CORS headers against a ruleset for common misconfigurations.
 * @param headers - The CORS headers to validate.
 * @param allowedOrigins - Allowed origins (not used in current checks).
 * @returns Array of violations found.
 */
export function validate(headers: Record<string, string>, allowedOrigins: string[]): Violation[] {
  const violations: Violation[] = [];

  // Check ACAO wildcard with credentials
  if (headers['Access-Control-Allow-Origin'] === '*' && headers['Access-Control-Allow-Credentials'] === 'true') {
    violations.push({
      severity: 'error',
      message: 'Wildcard ACAO with credentials allowed is a security risk',
      suggestion: 'Use specific origins instead of wildcard when credentials are required'
    });
  }

  // Check exposed headers for sensitive data
  const exposedHeaders = headers['Access-Control-Expose-Headers'] || '';
  const sensitiveHeaders = ['Authorization', 'Set-Cookie'];
  const exposed = exposedHeaders.split(',').map(h => h.trim());
  for (const header of exposed) {
    if (sensitiveHeaders.includes(header)) {
      violations.push({
        severity: 'warning',
        message: `Exposed header ${header} may leak sensitive information`,
        suggestion: 'Remove sensitive headers from Access-Control-Expose-Headers'
      });
    }
  }

  // Check preflight response correctness
  if (!headers['Access-Control-Allow-Methods'] || !headers['Access-Control-Allow-Headers']) {
    violations.push({
      severity: 'error',
      message: 'Preflight response missing required headers',
      suggestion: 'Ensure Access-Control-Allow-Methods and Access-Control-Allow-Headers are set'
    });
  }

  return violations;
}

/**
 * Renders a markdown report from validation results.
 * @param violations - Array of violations to report.
 * @returns Markdown CORS audit report.
 */
export function renderReport(violations: Violation[]): string {
  let markdown = '# CORS Policy Audit\n\n';
  markdown += '| Severity | Message | Suggestion |\n';
  markdown += '|---|---|---|\n';
  for (const violation of violations) {
    markdown += `| ${violation.severity} | ${violation.message} | ${violation.suggestion || 'N/A'} |\n';
  }
  return markdown;
}

export { Violation };