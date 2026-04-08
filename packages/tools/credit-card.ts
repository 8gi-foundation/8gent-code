/**
 * Removes all non-digit characters from a string.
 * @param number - The input string.
 * @returns A string containing only digits.
 */
function stripFormatting(number: string): string {
  return number.replace(/\D/g, '');
}

/**
 * Validates a credit card number using the Luhn algorithm.
 * @param number - The input string.
 * @returns True if valid, false otherwise.
 */
function isValid(number: string): boolean {
  const stripped = stripFormatting(number);
  let sum = 0;
  for (let i = stripped.length - 1, j = 0; i >= 0; i--, j++) {
    const digit = parseInt(stripped[i], 10);
    if (j % 2 === 1) {
      let doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return sum % 10 === 0;
}

/**
 * Masks a credit card number, showing only the last four digits.
 * @param number - The input string.
 * @returns A masked string in the format **** **** **** 1234.
 */
function mask(number: string): string {
  const stripped = stripFormatting(number);
  if (stripped.length < 4) return stripped;
  const lastFour = stripped.slice(-4);
  const rest = stripped.slice(0, -4);
  const groups = [];
  for (let i = 0; i < rest.length; i += 4) {
    groups.push('****');
  }
  return groups.join(' ') + ' ' + lastFour;
}

/**
 * Detects the credit card network.
 * @param number - The input string.
 * @returns Visa, Mastercard, Amex, or Unknown.
 */
function detectNetwork(number: string): string {
  const stripped = stripFormatting(number);
  if (stripped.length < 2) return 'Unknown';
  const firstDigit = stripped[0];
  const secondDigit = stripped[1];
  if (firstDigit === '4') return 'Visa';
  if (firstDigit === '5' && secondDigit >= '1' && secondDigit <= '5') return 'Mastercard';
  if (firstDigit === '2' && secondDigit >= '2' && secondDigit <= '7') return 'Mastercard';
  if ((firstDigit === '3' && secondDigit === '4') || (firstDigit === '3' && secondDigit === '7')) return 'Amex';
  return 'Unknown';
}

export { stripFormatting, isValid, mask, detectNetwork };