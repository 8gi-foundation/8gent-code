/**
 * Formats a currency value with locale and currency code.
 * @param amount - The numeric value to format.
 * @param currency - The currency code (e.g., USD, EUR).
 * @param locale - The locale to use for formatting.
 * @returns The formatted currency string.
 */
export function format(amount: number, currency: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    signDisplay: 'parentheses',
  });
  return formatter.format(amount);
}