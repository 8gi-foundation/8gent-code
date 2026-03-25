/**
 * token-counter.ts
 *
 * Token count estimators for context window management.
 * No external deps. Three estimation methods available.
 *
 * Methods:
 *   chars4       - chars / 4 (OpenAI rule of thumb for English)
 *   words        - words * 1.3 (accounts for punctuation/subword splits)
 *   tiktoken-approx - regex-based approximation mimicking cl100k_base splits
 */

export type TokenMethod = "chars4" | "words" | "tiktoken-approx";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

/** Overhead tokens per message in chat-format models (role + delimiters). */
const MESSAGE_OVERHEAD = 4;
/** Extra tokens appended to every chat request by the model. */
const REPLY_PRIMING_TOKENS = 3;

// ---------------------------------------------------------------------------
// Internal estimators
// ---------------------------------------------------------------------------

function byChars4(text: string): number {
  return Math.ceil(text.length / 4);
}

function byWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * 1.3);
}

/**
 * Regex-based approximation of cl100k_base tokenization.
 * Splits on:
 *   - contractions (e.g. "don't" -> "don", "'t")
 *   - runs of letters
 *   - runs of digits (groups of up to 3)
 *   - punctuation / whitespace tokens
 */
function byTiktokenApprox(text: string): number {
  if (!text) return 0;

  // cl100k_base primary split pattern (simplified)
  const pattern =
    /(?:'s|'t|'re|'ve|'m|'ll|'d)|(?:[A-Za-z]+)|(?:[0-9]{1,3})|(?:[^\s\w])/g;

  const matches = text.match(pattern);
  if (!matches) return 0;

  // Each match is approximately 1 token; long alpha runs may split further
  let count = 0;
  for (const token of matches) {
    if (/^[A-Za-z]+$/.test(token)) {
      // Rough subword split: every ~4 chars is a token for longer words
      count += Math.ceil(token.length / 4);
    } else {
      count += 1;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a single string.
 *
 * @param text   - The text to measure.
 * @param method - Estimation method. Defaults to "tiktoken-approx".
 */
export function countTokens(
  text: string,
  method: TokenMethod = "tiktoken-approx"
): number {
  if (!text) return 0;
  switch (method) {
    case "chars4":
      return byChars4(text);
    case "words":
      return byWords(text);
    case "tiktoken-approx":
      return byTiktokenApprox(text);
    default:
      throw new Error(`Unknown token method: ${method}`);
  }
}

/**
 * Estimate total token count for a chat message array.
 * Accounts for per-message overhead and reply priming tokens,
 * matching the format used by OpenAI chat completions.
 *
 * @param messages - Array of chat messages.
 * @param method   - Estimation method. Defaults to "tiktoken-approx".
 */
export function countMessages(
  messages: Message[],
  method: TokenMethod = "tiktoken-approx"
): number {
  let total = REPLY_PRIMING_TOKENS;

  for (const msg of messages) {
    total += MESSAGE_OVERHEAD;
    total += countTokens(msg.content, method);
    if (msg.name) {
      // Named messages cost one extra token for the name field
      total += countTokens(msg.name, method) + 1;
    }
  }

  return total;
}

/**
 * Check whether a piece of text fits within a context window limit.
 *
 * @param text   - The text to check.
 * @param limit  - The context window size in tokens.
 * @param method - Estimation method. Defaults to "tiktoken-approx".
 * @returns      - True if estimated tokens <= limit.
 */
export function fitsContext(
  text: string,
  limit: number,
  method: TokenMethod = "tiktoken-approx"
): boolean {
  return countTokens(text, method) <= limit;
}
