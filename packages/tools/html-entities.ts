/**
 * Encodes special characters to HTML entities.
 * @param str - The string to encode.
 * @returns The encoded string.
 */
export function encode(str: string): string {
  return str.replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  }[c]));
}

/**
 * Decodes HTML entities to characters.
 * @param str - The string to decode.
 * @returns The decoded string.
 */
export function decode(str: string): string {
  const div = document.createElement('div');
  div.innerHTML = str;
  return div.textContent || '';
}

/**
 * Encodes all non-ASCII characters to numeric HTML entities.
 * @param str - The string to encode.
 * @returns The encoded string.
 */
export function encodeAll(str: string): string {
  return str.replace(/[\u0080-\uFFFF]/g, (c) => {
    return `&#x${c.charCodeAt(0).toString(16)};`;
  });
}

/**
 * Removes all HTML tags from a string.
 * @param html - The HTML string.
 * @returns The string without HTML tags.
 */
export function stripTags(html: string): string {
  return html.replace(/<.*?>/g, '');
}