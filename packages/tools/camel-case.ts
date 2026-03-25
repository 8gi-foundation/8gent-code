/**
 * Converts a string to camelCase.
 * @param input - The string to convert.
 * @returns The converted string.
 */
export function toCamel(input: string): string {
  return process(input, (words) => {
    return words.map((word, index) => {
      if (index === 0) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join('');
  });
}

/**
 * Converts a string to PascalCase.
 * @param input - The string to convert.
 * @returns The converted string.
 */
export function toPascal(input: string): string {
  return process(input, (words) => {
    return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  });
}

/**
 * Converts a string to snake_case.
 * @param input - The string to convert.
 * @returns The converted string.
 */
export function toSnake(input: string): string {
  return process(input, (words) => {
    return words.join('_');
  });
}

/**
 * Converts a string to kebab-case.
 * @param input - The string to convert.
 * @returns The converted string.
 */
export function toKebab(input: string): string {
  return process(input, (words) => {
    return words.join('-');
  });
}

/**
 * Converts a string to SCREAMING_SNAKE_CASE.
 * @param input - The string to convert.
 * @returns The converted string.
 */
export function toScreaming(input: string): string {
  return process(input, (words) => {
    return words.map(word => word.toUpperCase()).join('_');
  });
}

function splitWords(input: string): string[] {
  return input
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map(word => word.toLowerCase())
    .filter(word => word.length > 0);
}

function process(input: string, transformer: (words: string[]) => string): string {
  const words = splitWords(input);
  return transformer(words);
}