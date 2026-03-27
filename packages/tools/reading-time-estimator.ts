/**
 * Estimates reading time for text content.
 * @param text - The text content to estimate.
 * @param options - Optional configuration.
 * @returns An object with minutes, seconds, and words.
 */
export function estimate(text: string, options: { wpm?: number; codeBlockTime?: (count: number) => number; imageTime?: (count: number) => number } = {}): { minutes: number; seconds: number; words: number } {
  const { wpm = 238, codeBlockTime = (count: number) => count * 30, imageTime = (count: number) => count * 12 } = options;

  const codeBlockRegex = /