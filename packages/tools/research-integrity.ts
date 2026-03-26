/**
 * Type for integrity issues detected during validation
 */
export type IntegrityIssue = {
  severity: 'FATAL' | 'MAJOR' | 'MINOR';
  message: string;
  match?: string;
};

/**
 * Validates research integrity by checking for claims without URLs, fabricated URLs, dead URLs, etc.
 * @param text - The text to validate
 * @returns Object with validation result and issues
 */
export function validateIntegrity(text: string): { valid: boolean; issues: IntegrityIssue[] } {
  const issues: IntegrityIssue[] = [];

  // Check for fabricated URLs
  const fabricatedUrls = text.match(/example\.com|test\.org/i);
  if (fabricatedUrls) {
    issues.push({
      severity: 'FATAL',
      message: 'Fabricated source URL detected',
      match: fabricatedUrls[0],
    });
  }

  // Check for claims without citations
  const sentences = text.split(/\.+/);
  for (const sentence of sentences) {
    if (!sentence.trim().match(/https?:\/\/[^\s]+/)) {
      issues.push({
        severity: 'MAJOR',
        message: 'Claim without citation',
        match: sentence.trim(),
      });
    }
  }

  // Check for dead URL patterns
  const deadUrls = text.match(/https?:\/\/[^\/]+$/);
  if (deadUrls) {
    issues.push({
      severity: 'MINOR',
      message: 'Incomplete reference pattern',
      match: deadUrls[0],
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Rules for integrity validation
 */
export const integrityRules = [
  {
    id: 'FATAL',
    description: 'Fabricated source URL detected',
    severity: 'FATAL',
  },
  {
    id: 'MAJOR',
    description: 'Claim without citation',
    severity: 'MAJOR',
  },
  {
    id: 'MINOR',
    description: 'Incomplete reference pattern',
    severity: 'MINOR',
  },
];