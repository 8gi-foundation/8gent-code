/**
 * Returns the plural category for the given count and locale.
 * @param count - The number to evaluate.
 * @param locale - The language locale (e.g., 'en', 'fr').
 * @returns The plural category ('zero', 'one', 'two', 'few', 'many', 'other').
 */
function plural(count: number, locale: string): PluralCategory {
  switch (locale) {
    case 'en':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      return 'other';
    case 'fr':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      return 'other';
    case 'de':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      return 'other';
    case 'es':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      return 'other';
    case 'pt':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      return 'other';
    case 'ru':
      const mod100 = count % 100;
      if (mod100 >= 11 && mod100 <= 19) {
        return 'other';
      }
      const mod10 = count % 10;
      if (mod10 === 1) return 'one';
      if (mod10 >= 2 && mod10 <= 4) return 'few';
      if (mod10 === 0 || mod10 >= 5 && mod10 <= 9) return 'many';
      return 'other';
    case 'ar':
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      if (count === 2) return 'two';
      if (count >= 3 && count <= 10) return 'few';
      if (count >= 11 && count <= 99) return 'many';
      return 'other';
    case 'zh':
      if (count === 0) return 'zero';
      return 'other';
    default:
      return 'other';
  }
}

/**
 * Selects the appropriate form from the forms array based on the plural category.
 * @param count - The number to evaluate.
 * @param forms - An array of forms ordered by plural category.
 * @param locale - The language locale (e.g., 'en', 'fr').
 * @returns The selected form string.
 */
function selectForm(count: number, forms: string[], locale: string): string {
  const category = plural(count, locale);
  const indexMap: { [key in PluralCategory]: number } = {
    zero: 0,
    one: 1,
    two: 2,
    few: 3,
    many: 4,
    other: 5
  };
  const index = indexMap[category];
  return forms[index];
}

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export { plural, selectForm };