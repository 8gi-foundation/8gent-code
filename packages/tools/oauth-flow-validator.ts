/**
 * Validates OAuth 2.0 authorization request parameters
 * @param params - Authorization request parameters
 * @returns Array of validation results
 */
export function validateAuthRequest(params: { [key: string]: any }): Validation[] {
  const validations: Validation[] = [];
  
  if (!params.response_type || !['code', 'token'].includes(params.response_type)) {
    validations.push({ type: 'response_type', message: 'Invalid or missing response_type', severity: 'error' });
  }
  
  if (!params.client_id) {
    validations.push({ type: 'client_id', message: 'Missing client_id', severity: 'error' });
  }
  
  if (params.redirect_uri && !/^https?:\/\//.test(params.redirect_uri)) {
    validations.push({ type: 'redirect_uri', message: 'Invalid redirect_uri format', severity: 'error' });
  }
  
  if (!params.state || typeof params.state !== 'string') {
    validations.push({ type: 'state', message: 'Missing or invalid state parameter', severity: 'error' });
  }
  
  if (params.scope && typeof params.scope !== 'string') {
    validations.push({ type: 'scope', message: 'Invalid scope format', severity: 'warning' });
  }
  
  return validations;
}

/**
 * Validates OAuth 2.0 callback parameters
 * @param params - Callback parameters
 * @param expectedState - Expected state value
 * @returns Array of validation results
 */
export function validateCallback(params: { [key: string]: any }, expectedState: string): Validation[] {
  const validations: Validation[] = [];
  
  if (params.error) {
    validations.push({ type: 'error', message: `Callback error: ${params.error}`, severity: 'error' });
  }
  
  if (params.state !== expectedState) {
    validations.push({ type: 'state', message: 'State mismatch', severity: 'error' });
  }
  
  return validations;
}

/**
 * Validates PKCE parameters
 * @param codeVerifier - Code verifier
 * @param codeChallenge - Code challenge
 * @param method - Code challenge method
 * @returns Array of validation results
 */
export function validatePKCE(codeVerifier: string, codeChallenge: string, method: 'S256' | 'plain'): Validation[] {
  const validations: Validation[] = [];
  
  if (!['S256', 'plain'].includes(method)) {
    validations.push({ type: 'method', message: 'Invalid code challenge method', severity: 'error' });
  }
  
  if (method === 'plain' && codeChallenge !== codeVerifier) {
    validations.push({ type: 'pkce', message: 'Code challenge does not match verifier', severity: 'error' });
  }
  
  if (method === 'S256' && !codeChallenge) {
    validations.push({ type: 'pkce', message: 'Missing code challenge for S256 method', severity: 'error' });
  }
  
  return validations;
}

/**
 * Renders validation results as markdown audit
 * @param validations - Array of validation results
 * @returns Markdown audit report
 */
export function renderReport(validations: Validation[]): string {
  const severityMap: { [key: string]: string[] } = { error: [], warning: [] };
  
  validations.forEach(v => severityMap[v.severity].push(`- ${v.type}: ${v.message}`));
  
  return `# OAuth Flow Audit\n\n## Errors\n${severityMap.error.length > 0 ? severityMap.error.join('\n') : 'None'}\n\n## Warnings\n${severityMap.warning.length > 0 ? severityMap.warning.join('\n') : 'None'}`;
}

/**
 * Validation result interface
 */
interface Validation {
  type: string;
  message: string;
  severity: 'error' | 'warning';
}