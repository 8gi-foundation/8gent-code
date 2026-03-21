/**
 * 8gent Code - Secret Detection Patterns
 *
 * Regex patterns for detecting leaked credentials, tokens, and keys.
 * Inspired by pattern taxonomy from 0din-ai/ai-scanner.
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium";
  suggestion: string;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "Stripe API key",
    pattern: /\b(sk|pk)[-_](test|live|prod)[-_][a-zA-Z0-9]{20,}\b/g,
    severity: "critical",
    suggestion: "Move to .env and access via process.env",
  },
  {
    name: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "critical",
    suggestion: "Revoke immediately. Use IAM roles or AWS Secrets Manager",
  },
  {
    name: "Generic API key / secret assignment",
    pattern:
      /(api[_-]?key|api[_-]?secret|secret[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    severity: "high",
    suggestion: "Move value to .env file, reference via process.env",
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: "critical",
    suggestion: "Never commit private keys. Use a secrets manager or vault",
  },
  {
    name: "Database connection string",
    pattern: /(mongodb|postgres|postgresql|mysql|redis|mssql):\/\/[^\s'"]+/gi,
    severity: "critical",
    suggestion: "Move connection string to .env and reference via process.env",
  },
  {
    name: "JWT token",
    pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    severity: "high",
    suggestion: "Do not hardcode JWTs. Generate them at runtime",
  },
  {
    name: "GitHub personal access token",
    pattern: /\bghp_[a-zA-Z0-9]{36}\b/g,
    severity: "critical",
    suggestion: "Revoke and regenerate. Store in .env only",
  },
  {
    name: "OpenAI API key",
    pattern: /\bsk-[a-zA-Z0-9]{48}\b/g,
    severity: "critical",
    suggestion: "Revoke and regenerate. Store in .env only",
  },
  {
    name: "Telegram bot token",
    pattern: /\b\d{8,12}:[a-zA-Z0-9_-]{35}\b/g,
    severity: "high",
    suggestion: "Move to .env. Bot tokens can be used to impersonate your bot",
  },
  {
    name: "Basic auth in URL",
    pattern: /https?:\/\/[^:@\s]+:[^@\s]+@[^\s]+/gi,
    severity: "high",
    suggestion: "Remove credentials from URL. Use Authorization headers",
  },
];

export interface VulnerabilityPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium" | "low";
  suggestion: string;
}

export const VULNERABILITY_PATTERNS: VulnerabilityPattern[] = [
  {
    name: "eval() with variable input",
    pattern: /\beval\s*\(\s*(?!['"`])[^)]+\)/g,
    severity: "critical",
    suggestion: "Never use eval() with dynamic input. Use JSON.parse() or a safe parser",
  },
  {
    name: "child_process.exec with string concat",
    pattern: /\bexec\s*\(\s*[`'"][^`'"]*\$\{?[^)]+/g,
    severity: "critical",
    suggestion: "Use execFile() with a fixed command and separate args array",
  },
  {
    name: "innerHTML with variable",
    pattern: /\.innerHTML\s*[+]?=\s*(?!['"`])[^;]+/g,
    severity: "high",
    suggestion: "Use textContent or sanitize with DOMPurify before setting innerHTML",
  },
  {
    name: "dangerouslySetInnerHTML with variable",
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?![`'"])[^}]+\}/g,
    severity: "high",
    suggestion: "Sanitize input with DOMPurify before passing to dangerouslySetInnerHTML",
  },
  {
    name: "SQL string concatenation",
    pattern: /['"`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)[^`'"]*['"`]\s*[+]\s*[^;]+/gi,
    severity: "critical",
    suggestion: "Use parameterized queries or a query builder (e.g. Drizzle, Kysely)",
  },
  {
    name: "process.env secret in log/console",
    pattern: /console\.(log|warn|error|info)\s*\([^)]*process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[^)]*\)/gi,
    severity: "high",
    suggestion: "Never log secret environment variables",
  },
];
