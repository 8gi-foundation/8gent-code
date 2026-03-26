/**
 * Generates a complete set of recommended HTTP security headers.
 * @param params - Configuration parameters
 * @returns Security headers object
 */
export function buildHeaders({
  environment,
  framePolicy,
  hstsMaxAge,
  cspPolicy,
}: {
  environment: string;
  framePolicy?: string;
  hstsMaxAge?: number;
  cspPolicy?: string;
}): Record<string, string> {
  const base = defaults(environment);
  const headers: Record<string, string> = { ...base };

  if (framePolicy !== undefined) headers['X-Frame-Options'] = framePolicy;
  if (hstsMaxAge !== undefined)
    headers['Strict-Transport-Security'] = `max-age=${hstsMaxAge}`;
  if (cspPolicy !== undefined) headers['Content-Security-Policy'] = cspPolicy;

  return headers;
}

/**
 * Returns opinionated default headers for development or production.
 * @param env - Environment name
 * @returns Default headers
 */
export function defaults(env: string): Record<string, string> {
  const isProduction = env === 'production';
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Referrer-Policy': isProduction ? 'no-referrer' : 'strict-origin-when-cross-origin',
    'X-Frame-Options': isProduction ? 'DENY' : 'SAMEORIGIN',
    'Content-Security-Policy': isProduction
      ? "default-src 'self'; script-src 'self' https://trusted.cdn; style-src 'self' https://trusted.cdn"
      : "default-src 'self'",
    'Strict-Transport-Security': isProduction
      ? 'max-age=31536000; includeSubDomains; preload'
      : 'max-age=0',
    'X-XSS-Protection': '1; mode=block',
  };
}

/**
 * Renders headers as nginx add_header directives.
 * @param headers - Security headers
 * @returns Nginx configuration string
 */
export function toNginxConf(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `add_header ${key} "${value}";`)
    .join('\n');
}

/**
 * Renders headers as Express middleware code snippet.
 * @param headers - Security headers
 * @returns Express middleware code string
 */
export function toExpressMiddleware(headers: Record<string, string>): string {
  return `function (req, res, next) {\n${
    Object.entries(headers)
      .map(([key, value]) => `  res.setHeader('${key}', '${value}');`)
      .join('\n')
  }\n  next();\n}`;
}