/**
 * Input sanitization — strip invisible Unicode characters before fact extraction.
 * Defends against prompt injection via Unicode Tags (invisible text that models
 * can read but humans cannot), zero-width chars, and bidi marks.
 */

export function sanitize(input: string): string {
  return input
    // Unicode Tags (U+E0000-U+E007F) — invisible instructions
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    // Zero-width characters
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "")
    // Bidirectional marks
    .replace(/[\u2066-\u2069\u202A-\u202E]/g, "")
    // Variation selectors
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
    .trim();
}
