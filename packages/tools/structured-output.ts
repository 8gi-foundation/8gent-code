/**
 * Extracts JSON from markdown code blocks or raw text.
 * @param text - The input text containing JSON.
 * @returns The extracted JSON string.
 */
export function extract(text: string): string {
  const match = text.match(/