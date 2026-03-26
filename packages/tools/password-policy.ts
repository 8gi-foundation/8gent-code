/**
 * Password security policy configuration.
 */
interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

/**
 * Validate a password against a security policy.
 * @param password The password to validate.
 * @param policy The security policy to apply.
 * @returns An object indicating validation success and any violations.
 */
function validate(password: string, policy: PasswordPolicy): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (password.length < policy.minLength) violations.push(`Password too short (min ${policy.minLength})`);
  if (policy.requireUpper && !/[A-Z]/.test(password)) violations.push('Missing uppercase letter');
  if (policy.requireDigit && !/\d/.test(password)) violations.push('Missing digit');
  if (policy.requireSymbol && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) violations.push('Missing symbol');
  return { ok: violations.length === 0, violations };
}

/**
 * Calculate the strength of a password.
 * @param password The password to evaluate.
 * @returns A strength score between 0 and 100.
 */
function strength(password: string): number {
  let score = 0;
  score += Math.min(password.length, 20) * (25 / 20);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  if (hasUpper) score += 25;
  if (hasDigit) score += 25;
  if (hasSymbol) score += 25;
  return Math.min(score, 100);
}

/**
 * Generate a strong, policy-compliant password.
 * @param len Optional length of the password. Defaults to 12.
 * @returns A randomly generated password.
 */
function generateStrong(len?: number): string {
  const policy: PasswordPolicy = { minLength: len || 12, requireUpper: true, requireDigit: true, requireSymbol: true };
  const requiredChars: string[] = [];
  if (policy.requireUpper) requiredChars.push(String.fromCharCode(65 + Math.floor(Math.random() * 26)));
  if (policy.requireDigit) requiredChars.push(String.fromCharCode(48 + Math.floor(Math.random() * 10)));
  if (policy.requireSymbol) {
    const symbols = '!@#$%^&*(),.?":{}|<>';
    requiredChars.push(symbols[Math.floor(Math.random() * symbols.length)]);
  }
  const remainingLength = Math.max(policy.minLength - requiredChars.length, 0);
  const allChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*(),.?":{}|<>';
  for (let i = 0; i < remainingLength; i++) {
    requiredChars.push(allChars[Math.floor(Math.random() * allChars.length)]);
  }
  for (let i = requiredChars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [requiredChars[i], requiredChars[j]] = [requiredChars[j], requiredChars[i]];
  }
  return requiredChars.join('');
}

export { PasswordPolicy, validate, strength, generateStrong };