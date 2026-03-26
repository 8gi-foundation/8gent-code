/**
 * Analyzes API routes for Insecure Direct Object Reference (IDOR) vulnerabilities
 */
export class RouteAnalyzer {
  /** Route path */
  path: string;
  /** HTTP method */
  method: string;
  /** Has auth middleware */
  hasAuth: boolean;
  /** Detected ID parameters */
  idParams: string[];

  constructor(route: { path: string; method: string; hasAuth: boolean }) {
    this.path = route.path;
    this.method = route.method;
    this.hasAuth = route.hasAuth;
    this.idParams = [];
  }

  /**
   * Check if route matches IDOR pattern (GET with :id/:userId params)
   */
  private patternMatch(): boolean {
    const idRegex = /\/([a-zA-Z0-9_]+)\/:\w+/;
    return this.method === 'GET' && idRegex.test(this.path);
  }

  /**
   * Scan route for IDOR risks
   */
  scan(): boolean {
    if (!this.patternMatch()) return false;
    const paramRegex = /\/:\w+/g;
    this.idParams = this.path.match(paramRegex) || [];
    return !this.hasAuth && this.idParams.length > 0;
  }
}

/**
 * Scans routes for IDOR anti-patterns
 * @param routes Array of route objects { path, method, hasAuth }
 * @returns Array of vulnerable routes
 */
export function scanRoutes(routes: { path: string; method: string; hasAuth: boolean }[]): RouteAnalyzer[] {
  return routes
    .map(route => new RouteAnalyzer(route))
    .filter(analyzer => analyzer.scan());
}

/**
 * Generate markdown report from scan results
 * @param results Array of vulnerable routes
 * @returns Markdown report string
 */
export function renderReport(results: RouteAnalyzer[]): string {
  return results.length
    ? `# IDOR Vulnerability Report\n\n## Issues Found:\n${results
        .map(
          (route, i) => `**${i + 1}.** Route: ${route.path} (${route.method})\n- Detected ID params: ${route.idParams.join(', ')}\n- Missing auth middleware`
        )
        .join('\n\n')}`
    : '# IDOR Vulnerability Report\n\nNo IDOR vulnerabilities found';
}

/**
 * Generate remediation recommendation
 * @param route RouteAnalyzer instance
 * @returns Remediation recommendation string
 */
export function remediation(route: RouteAnalyzer): string {
  return `Implement ownership verification middleware for ${route.idParams.join(', ')} parameters. Example: Verify request.user.id matches resource owner ID before allowing access.`;
}