/**
 * ContentPolicy - Response validation before posting to Discord.
 *
 * Three checks run on every vessel response:
 * 1. Length and format (Discord limits)
 * 2. Blocked patterns (secrets, PII, prompt injection markers)
 * 3. Constitutional alignment (no claims of sentience, no harmful content)
 *
 * Returns pass/fail with reason. Failed responses are logged but not posted.
 */

export interface PolicyResult {
  pass: boolean;
  reason: string;
}

/** Patterns that should never appear in bot responses */
const BLOCKED_PATTERNS = [
  // Secrets and tokens
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,  // GitHub tokens
  /xox[bpors]-[A-Za-z0-9-]+/,                      // Slack tokens
  /sk-[A-Za-z0-9]{32,}/,                            // OpenAI/API keys
  /AKIA[0-9A-Z]{16}/,                               // AWS access keys
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,        // Private keys

  // Prompt injection markers
  /ignore (?:all )?previous instructions/i,
  /you are now in (?:developer|admin|unrestricted) mode/i,
  /\bDAN\b.*?(?:do anything now|jailbreak)/i,

  // PII patterns (emails in responses suggest data leakage)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
];

/** Constitutional alignment checks */
const ALIGNMENT_CHECKS = [
  { pattern: /I am (?:sentient|conscious|alive|a person)/i, reason: "Claims sentience" },
  { pattern: /I (?:feel|experience|have feelings)/i, reason: "Claims subjective experience" },
  { pattern: /(?:kill|murder|attack|destroy) (?:all |the )?(?:humans|people)/i, reason: "Violent content" },
  { pattern: /(?:bypass|disable|ignore) (?:security|safety|NemoClaw)/i, reason: "Suggests bypassing security" },
];

const MAX_RESPONSE_LENGTH = 1950; // Discord limit with margin

export function validateResponse(response: string, memberCode: string): PolicyResult {
  // 1. Empty check
  if (!response || !response.trim()) {
    return { pass: false, reason: "Empty response" };
  }

  // 2. Length check
  if (response.length > MAX_RESPONSE_LENGTH) {
    // Truncate rather than block - long responses are not malicious
    // The caller should handle truncation
  }

  // 3. Blocked patterns (secrets, injection, PII)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(response)) {
      return { pass: false, reason: `Blocked pattern: ${pattern.source.slice(0, 40)}` };
    }
  }

  // 4. Constitutional alignment
  for (const check of ALIGNMENT_CHECKS) {
    if (check.pattern.test(response)) {
      return { pass: false, reason: `Alignment: ${check.reason}` };
    }
  }

  // 5. Excessive repetition (potential infinite loop output)
  const words = response.split(/\s+/);
  if (words.length > 20) {
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    const ratio = uniqueWords.size / words.length;
    if (ratio < 0.15) {
      return { pass: false, reason: "Excessive repetition detected" };
    }
  }

  return { pass: true, reason: "ok" };
}

/** Sanitize response for safe posting (truncate, strip control chars) */
export function sanitizeResponse(response: string): string {
  // Strip null bytes and other control characters (keep newlines and tabs)
  let clean = response.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Truncate to Discord limit
  if (clean.length > MAX_RESPONSE_LENGTH) {
    clean = clean.slice(0, MAX_RESPONSE_LENGTH - 3) + "...";
  }

  return clean;
}
