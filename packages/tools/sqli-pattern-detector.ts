/**
 * SQL injection pattern detector utility
 */
export class SqlInjector {
  private patterns = [
    { regex: /UNION\s+SELECT/i, severity: 'high' },
    { regex: /OR\s+1=1/i, severity: 'medium' },
    { regex: /--/i, severity: 'medium' },
    { regex: /#/i, severity: 'medium' },
    { regex: /;\s*$/i, severity: 'high' }
  ];

  /**
   * Detects SQL injection patterns in input string
   * @param input - String to scan
   * @returns Detection results
   */
  detect(input: string): { detected: boolean; patterns: string[]; severity: string } {
    const matches = this.patterns
      .map(p => ({ ...p, match: input.match(p.regex) }))
      .filter(m => m.match !== null)
      .map(m => ({ pattern: m.regex.source, severity: m.severity }));

    return {
      detected: matches.length > 0,
      patterns: matches.map(m => m.pattern),
      severity: matches.reduce((s, m) => Math.max(s, m.severity as any), 'low') as any
    };
  }

  /**
   * Scans multiple input fields for injection patterns
   * @param inputs - Object with field names as keys
   * @returns Per-field detection results
   */
  scan(inputs: Record<string, string>): Record<string, any> {
    return Object.entries(inputs).reduce((results, [field, value]) => {
      results[field] = this.detect(value);
      return results;
    }, {} as Record<string, any>);
  }

  /**
   * Renders detection results as table
   * @param results - Results from scan()
   * @returns Formatted table string
   */
  renderReport(results: Record<string, any>): string {
    const headers = ['Field', 'Input', 'Detected Patterns', 'Severity'];
    const rows = Object.entries(results).map(([field, res]) => [
      field,
      res.detected ? res.patterns.join(', ') : 'Clean',
      res.severity
    ]);
    return `| ${headers.join(' | ')} |\n| ${'---|'.repeat(headers.length - 1)}|\n${rows
      .map(row => `| ${row.join(' | ')} |`)
      .join('\n')}`;
  }

  /**
   * Provides sanitization hint for detected pattern
   * @param pattern - Detected pattern
   * @returns Sanitization suggestion
   */
  sanitizeHint(pattern: string): string {
    return `Use parameterized queries instead of concatenating ${pattern} directly into SQL statements`;
  }
}