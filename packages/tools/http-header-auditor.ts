/**
 * Audit HTTP response headers for security best practices and OWASP recommendations.
 * @param headers - HTTP response headers to audit.
 * @returns Audit result with present, missing, misconfigured headers and a score.
 */
export function audit(headers: Record<string, string>): AuditResult {
  const requiredHeaders = [
    'X-Frame-Options',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy'
  ];

  const present: string[] = [];
  const missing: string[] = [];
  const misconfigured: string[] = [];

  for (const header of requiredHeaders) {
    if (!(header in headers)) {
      missing.push(header);
    } else {
      const isValid = checkHeader(header, headers[header]);
      if (isValid) {
        present.push(header);
      } else {
        misconfigured.push(header);
      }
    }
  }

  const total = requiredHeaders.length;
  const correct = present.length;
  const score = Math.round((correct / total) * 100);

  return { present, missing, misconfigured, score };
}

/**
 * Validate individual header value correctness.
 * @param name - Header name.
 * @param value - Header value.
 * @returns True if value is valid, false otherwise.
 */
export function checkHeader(name: string, value: string): boolean {
  if (name === 'X-Frame-Options') {
    return value === 'DENY' || value === 'SAMEORIGIN';
  }

  if (name === 'Strict-Transport-Security') {
    const parts = value.split(';').map(p => p.trim());
    let maxAge = 0;
    for (const part of parts) {
      if (part.startsWith('max-age=')) {
        maxAge = parseInt(part.split('=')[1], 10);
      }
    }
    return maxAge >= 31536000;
  }

  if (name === 'X-Content-Type-Options') {
    return value === 'nosniff';
  }

  if (name === 'Referrer-Policy') {
    const validValues = [
      'no-referrer',
      'no-referrer-when-downgrade',
      'origin',
      'origin-when-cross-origin',
      'strict-origin',
      'strict-origin-when-cross-origin',
      'same-origin'
    ];
    return validValues.includes(value);
  }

  if (name === 'Permissions-Policy') {
    return value.trim() !== '';
  }

  return false;
}

/**
 * Generate markdown report from audit result.
 * @param audit - Audit result.
 * @returns Markdown report with pass/fail status and remediation.
 */
export function renderReport(audit: AuditResult): string {
  let report = '# HTTP Security Header Audit Report\n\n';
  report += `**Score**: ${audit.score}%\n\n';

  report += '## Headers Check\n\n';
  for (const header of audit.present) {
    report += `- ${header}: ✅ Present and correctly configured\n`;
  }
  for (const header of audit.missing) {
    let remediation = '';
    switch (header) {
      case 'X-Frame-Options':
        remediation = 'Add with value "DENY" or "SAMEORIGIN"';
        break;
      case 'Strict-Transport-Security':
        remediation = 'Add with value "max-age=31536000; includeSubDomains"';
        break;
      case 'X-Content-Type-Options':
        remediation = 'Add with value "nosniff"';
        break;
      case 'Referrer-Policy':
        remediation = 'Add with valid value (e.g., "no-referrer", "strict-origin-when-cross-origin")';
        break;
      case 'Permissions-Policy':
        remediation = 'Add with appropriate directives (e.g., "camera=(), geolocation=(self)")';
        break;
      default:
        remediation = 'Add header with correct value based on security best practices';
    }
    report += `- ${header}: ❌ Missing. Remediation: ${remediation}\n`;
  }
  for (const header of audit.misconfigured) {
    let remediation = '';
    switch (header) {
      case 'X-Frame-Options':
        remediation = 'Set to "DENY" or "SAMEORIGIN"';
        break;
      case 'Strict-Transport-Security':
        remediation = 'Ensure "max-age" is at least 31536000 and consider "includeSubDomains"';
        break;
      case 'X-Content-Type-Options':
        remediation = 'Set to "nosniff"';
        break;
      case 'Referrer-Policy':
        remediation = 'Use valid value (e.g., "no-referrer", "strict-origin-when-cross-origin")';
        break;
      case 'Permissions-Policy':
        remediation = 'Configure with appropriate directives (e.g., "camera=(), geolocation=(self)")';
        break;
      default:
        remediation = 'Check correct value for this header based on security best practices';
    }
    report += `- ${header}: ⚠️ Misconfigured. Remediation: ${remediation}\n`;
  }

  return report;
}

/**
 * Audit result interface.
 */
export interface AuditResult {
  present: string[];
  missing: string[];
  misconfigured: string[];
  score: number;
}