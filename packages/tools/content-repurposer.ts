/**
 * Splits text into tweet-length chunks with continuity.
 * @param text - The input text.
 * @param n - Maximum characters per tweet (default 280).
 * @returns Array of tweet-length strings.
 */
export function toTweets(text: string, n: number = 280): string[] {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, n);
    result.push(chunk);
    remaining = remaining.slice(n);
  }
  return result;
}

/**
 * Reformats text as LinkedIn post with hook and CTA.
 * @param text - The input text.
 * @returns Formatted LinkedIn post.
 */
export function toLinkedIn(text: string): string {
  const sentences = text.split('.').map(s => s.trim());
  const hook = sentences[0] || 'Check this out!';
  const body = sentences.slice(1).join('. ');
  return `${hook}\n\n${body}\n\nWhat are your thoughts? Let me know in the comments!`;
}

/**
 * Extracts key points as bullet list.
 * @param text - The input text.
 * @param n - Maximum number of bullets (default 5).
 * @returns Array of bullet points.
 */
export function toBullets(text: string, n: number = 5): string[] {
  return text.split('.').map(s => s.trim()).filter(s => s).slice(0, n);
}

/**
 * Condenses text to email-appropriate length.
 * @param text - The input text.
 * @param words - Maximum words (default 150).
 * @returns Condensed email blurb.
 */
export function toEmailBlurb(text: string, words: number = 150): string {
  const wordsArray = text.split(/\s+/);
  return wordsArray.slice(0, words).join(' ') + (wordsArray.length > words ? '...' : '');
}

/**
 * Renders all formats in a single output document.
 * @param text - The input text.
 * @returns Object containing all formatted outputs.
 */
export function renderAll(text: string): {
  tweets: string[];
  linkedIn: string;
  bullets: string[];
  email: string;
} {
  return {
    tweets: toTweets(text),
    linkedIn: toLinkedIn(text),
    bullets: toBullets(text),
    email: toEmailBlurb(text)
  };
}