/**
 * Pluralizes or singularizes a word based on count.
 * @param word The word to pluralize or singularize.
 * @param count The count to determine pluralization (optional).
 * @returns The plural or singular form of the word.
 */
export function pluralize(word: string, count?: number): string {
  if (count === 1) {
    return singularize(word);
  }
  if (uncountables.has(word)) {
    return word;
  }
  const singular = irregulars.get(word);
  if (singular) {
    return singular;
  }
  return defaultPluralize(word);
}

/**
 * Singularizes a word.
 * @param word The word to singularize.
 * @returns The singular form of the word.
 */
export function singularize(word: string): string {
  if (uncountables.has(word)) {
    return word;
  }
  const plural = irregulars.get(word);
  if (plural) {
    return findSingular(plural);
  }
  return defaultSingularize(word);
}

/**
 * Adds a custom irregular pluralization rule.
 * @param singular The singular form of the word.
 * @param plural The plural form of the word.
 */
export function addIrregular(singular: string, plural: string): void {
  irregulars.set(singular, plural);
}

const irregulars = new Map<string, string>([
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['tooth', 'teeth'],
  ['foot', 'feet'],
  ['mouse', 'mice'],
  ['louse', 'lice'],
  ['ox', 'oxen'],
]);

const uncountables = new Set<string>([
  'information',
  'series',
  'species',
  'money',
  'news',
  'physics',
  'mathematics',
  'economics',
]);

function defaultPluralize(word: string): string {
  if (/s|x|z|ch|sh$/.test(word)) {
    return word + 'es';
  }
  if (/[^aeiou]y$/.test(word)) {
    return word.replace('y', 'ies');
  }
  return word + 's';
}

function defaultSingularize(word: string): string {
  if (/es$/.test(word)) {
    if (/s|x|z|ch|sh$/.test(word)) {
      return word.slice(0, -2);
    }
    if (/ies$/.test(word)) {
      return word.slice(0, -3) + 'y';
    }
  }
  if (/s$/.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

function findSingular(plural: string): string {
  for (const [singular, p] of irregulars) {
    if (p === plural) {
      return singular;
    }
  }
  return defaultSingularize(plural);
}