/**
 * Converts a string to a URL-safe slug.
 * @param input - The input string to convert.
 * @param separator - The separator character (default: hyphen).
 * @returns The slugified string.
 */
export function slugify(input: string, separator: string = '-'): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, separator)
    .replace(/-+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, 'g'), '');
}