/**
 * Estimate entropy of a string for password strength analysis.
 * @param str - Input string
 * @returns Estimated entropy in bits
 */
function entropy(str: string): number {
  const size = charsetSize(str);
  if (size === 0) return 0;
  return Math.log2(Math.pow(size, str.length));
}

/**
 * Calculate the character set cardinality of a string.
 * @param str - Input string
 * @returns Number of unique characters
 */
function charsetSize(str: string): number {
  return new Set(str).size;
}

/**
 * Check if a string is a common password.
 * @param str - Input string
 * @returns True if in blocklist
 */
function isCommonPassword(str: string): boolean {
  return commonPasswords.has(str.toLowerCase());
}

/**
 * Estimate password strength score (0-4) based on patterns.
 * @param str - Input string
 * @returns Strength score
 */
function zxcvbnLite(str: string): number {
  if (isCommonPassword(str)) return 1;
  if (str.length < 4) return 0;
  const size = charsetSize(str);
  if (size === 1) return 1;
  if (isSequence(str)) return 2;
  if (hasRepeats(str)) return 2;
  if (str.length >= 8 && entropy(str) > 35) return 3;
  if (str.length >= 12 && entropy(str) > 50) return 4;
  return 2;
}

// Internal helper functions
const commonPasswords = new Set([
  "password", "123456", "qwerty", "abc123", "123456789", "12345678", "12345", "1234567", "1234567890", "admin", "letmein", "welcome", "monkey", "12345678901234567890", "123456789012345678901234567890"
]);

function isSequence(str: string): boolean {
  for (let i = 1; i < str.length; i++) {
    const diff = str.charCodeAt(i) - str.charCodeAt(i - 1);
    if (Math.abs(diff) !== 1) return false;
  }
  return true;
}

function hasRepeats(str: string): boolean {
  for (let len = 1; len <= str.length / 2; len++) {
    if (str.length % len === 0) {
      const repeat = str.substring(0, len);
      let isRepeat = true;
      for (let i = len; i < str.length; i += len) {
        if (str.substring(i, i + len) !== repeat) {
          isRepeat = false;
          break;
        }
      }
      if (isRepeat) return true;
    }
  }
  return false;
}

export { entropy, charsetSize, zxcvbnLite, isCommonPassword };