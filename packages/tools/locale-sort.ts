/**
 * Compares two strings using the specified locale and collation rules.
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @param locale - Locale to use for comparison.
 * @param ignoreDiacritics - Whether to ignore diacritics in comparison.
 * @returns -1 if a comes before b, 1 if a comes after b, 0 if equal.
 */
export function compare(a: string, b: string, locale: string, ignoreDiacritics?: boolean): number {
  const options: Intl.CollatorOptions = {
    numeric: true,
    sensitivity: ignoreDiacritics ? 'base' : 'variant'
  };
  const collator = new Intl.Collator(locale, options);
  return collator.compare(a, b);
}

/**
 * Sorts an array of items using locale-aware string comparison.
 * @param items - Array to sort.
 * @param locale - Locale to use for sorting.
 * @param key - Function to extract the sort key from each item.
 * @param ignoreDiacritics - Whether to ignore diacritics in comparison.
 * @returns Sorted array.
 */
export function sort<T>(items: T[], locale?: string, key?: (item: T) => string, ignoreDiacritics?: boolean): T[] {
  return [...items].sort((a, b) => {
    const aKey = key ? key(a) : (a as any as string);
    const bKey = key ? key(b) : (b as any as string);
    return compare(aKey, bKey, locale || 'en-US', ignoreDiacritics);
  });
}