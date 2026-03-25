/**
 * output-sanitizer.ts
 *
 * Sanitizes agent output by detecting and redacting API keys, tokens, emails,
 * IP addresses, file paths with home directories, and passwords in URLs.
 *
 * Usage:
 *   import { sanitize } from "./packages/tools/output-sanitizer";
 *   const clean = sanitize(rawOutput);
 */

export interface SanitizerOptions {
  /** Replacement token for redacted values. Default: "[REDACTED]" */
  placeholder?: string;
  /** Disable specific rules. Default: all enabled. */
  disable?: Array<
    | "apiKey"
    | "bearerToken"
    | "jwtToken"
    | "email"
    | "ipAddress"
    | "homePath"
    | "urlPassword"
    | "privateKey"
    | "awsKey"
  >;
}

export interface SanitizerResult {
  text: string;
  /** Number of redactions applied */
  count: number;
  /** Which rule types triggered (deduplicated) */
  types: string[];
}

type Rule = {
  name: string;
  pattern: RegExp;
  replace: (match: string, placeholder: string) => string;
};

const RULES: Rule[] = [
  // AWS access key IDs: AKIA... (20 chars)
  {
    name: "awsKey",
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    replace: (_m, p) => p,
  },
  // Generic API keys - common patterns like sk-, pk-, rk-, api-
  {
    name: "apiKey",
    pattern: /\b(sk|pk|rk|api|token|key)[-_][A-Za-z0-9\-_]{20,80}\b/gi,
    replace: (_m, p) => p,
  },
  // Bearer tokens in Authorization headers
  {
    name: "bearerToken",
    pattern: /(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/gi,
    replace: (m, p) => m.replace(/([^\s]+)$/, p),
  },
  // JWT tokens: three base64url segments separated by dots
  {
    name: "jwtToken",
    pattern: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.~+/]*\b/g,
    replace: (_m, p) => p,
  },
  // PEM private keys
  {
    name: "privateKey",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: (_m, p) => `-----BEGIN PRIVATE KEY-----\n${p}\n-----END PRIVATE KEY-----`,
  },
  // Passwords embedded in URLs: https://user:password@host
  {
    name: "urlPassword",
    pattern: /(https?:\/\/[^:@\s]+:)[^@\s]+(@)/gi,
    replace: (m, p) => m.replace(/(:[^@\s]+)(@)/, `:${p}$2`),
  },
  // Email addresses
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replace: (_m, p) => p,
  },
  // IPv4 addresses (non-loopback, non-private - redact all for safety)
  {
    name: "ipAddress",
    pattern: /\b(?!0\.)(?!127\.)(?!255\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replace: (_m, p) => p,
  },
  // File paths that include home directory (~/ or /Users/<name>/ or /home/<name>/)
  {
    name: "homePath",
    pattern: /(~\/[^\s"']+|\/(?:Users|home)\/[^/\s"']+\/[^\s"']*)/g,
    replace: (_m, p) => p,
  },
];

/**
 * Sanitizes a string by redacting sensitive patterns.
 *
 * @param text - Raw text to sanitize.
 * @param options - Optional configuration.
 * @returns Sanitized result with redaction metadata.
 */
export function sanitize(text: string, options: SanitizerOptions = {}): SanitizerResult {
  const placeholder = options.placeholder ?? "[REDACTED]";
  const disabled = new Set(options.disable ?? []);

  let result = text;
  let count = 0;
  const types: Set<string> = new Set();

  for (const rule of RULES) {
    if (disabled.has(rule.name as never)) continue;

    // Reset lastIndex for global regexes
    rule.pattern.lastIndex = 0;

    const replaced = result.replace(rule.pattern, (match) => {
      count++;
      types.add(rule.name);
      return rule.replace(match, placeholder);
    });

    result = replaced;
  }

  return { text: result, count, types: Array.from(types) };
}

/**
 * Convenience wrapper - returns the sanitized string directly.
 */
export function sanitizeText(text: string, options?: SanitizerOptions): string {
  return sanitize(text, options).text;
}
