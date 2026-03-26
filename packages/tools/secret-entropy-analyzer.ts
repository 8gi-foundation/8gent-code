/**
 * Calculates Shannon entropy of a string in bits.
 * @param str - Input string
 * @returns Entropy value in bits
 */
export function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in freq) {
    const p = freq[char] / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Returns entropy threshold based on context.
 * @param context - 'env', 'url', or 'code'
 * @returns Threshold value
 */
export function threshold(context: 'env' | 'url' | 'code'): number {
  switch (context) {
    case 'env': return 3.5;
    case 'url': return 2.5;
    case 'code': return 4.0;
    default: return 3.0;
  }
}

/**
 * Heuristic to determine if a string is likely a secret.
 * @param str - Input string
 * @returns True if likely a secret
 */
export function isLikelySecret(str: string): boolean {
  const entropy = shannonEntropy(str);
  const len = str.length;
  if (len < 8 || len > 100) return false;
  if (entropy < 3.5) return false;
  const hasLetter = /[a-zA-Z]/.test(str);
  const hasNumber = /\d/.test(str);
  const hasSymbol = /[^a-zA-Z0-9]/.test(str);
  return (hasLetter && hasNumber) || hasSymbol;
}

/**
 * Tokenizes text and flags high-entropy tokens.
 * @param text - Input text
 * @returns Array of token analysis results
 */
export function scanTokens(text: string): Array<{token: string; entropy: number; isSuspicious: boolean}> {
  const tokens = text.split(/\s+/);
  return tokens.map(token => ({
    token,
    entropy: shannonEntropy(token),
    isSuspicious: isLikelySecret(token)
  }));
}

/**
 * Renders a report of suspicious tokens with entropy scores.
 * @param results - Array of token analysis results
 * @returns Formatted report string
 */
export function renderReport(results: Array<{token: string; entropy: number; isSuspicious: boolean}>): string {
  return results
    .filter(r => r.isSuspicious)
    .map(r => `Token: ${r.token} | Entropy: ${r.entropy.toFixed(2)}`)
    .join('\n');
}