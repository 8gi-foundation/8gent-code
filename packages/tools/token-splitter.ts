/**
 * token-splitter.ts
 *
 * Splits text into chunks that fit within token limits.
 * Respects sentence and paragraph boundaries, supports configurable overlap.
 *
 * Token estimation: ~4 chars per token (GPT-4 average for English prose).
 */

export interface SplitOptions {
  /** Overlap in tokens between consecutive chunks. Default: 50. */
  overlap?: number;
  /** Preferred boundary: "paragraph" | "sentence" | "word". Default: "sentence". */
  boundary?: "paragraph" | "sentence" | "word";
  /** Source identifier attached to each chunk's metadata. */
  source?: string;
}

export interface TextChunk {
  /** The chunk text. */
  text: string;
  /** Estimated token count for this chunk. */
  tokens: number;
  /** Zero-based index of this chunk. */
  index: number;
  /** Character offset where this chunk starts in the original text. */
  startChar: number;
  /** Character offset where this chunk ends (exclusive) in the original text. */
  endChar: number;
  /** Optional source label passed via options. */
  source?: string;
}

/** Rough estimate: 1 token ~= 4 chars for English prose. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
}

function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or end-of-string.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitIntoWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function getSegments(text: string, boundary: "paragraph" | "sentence" | "word"): string[] {
  switch (boundary) {
    case "paragraph":
      return splitIntoParagraphs(text);
    case "word":
      return splitIntoWords(text);
    case "sentence":
    default:
      return splitIntoSentences(text);
  }
}

function joinSegments(segments: string[], boundary: "paragraph" | "sentence" | "word"): string {
  const sep = boundary === "paragraph" ? "\n\n" : " ";
  return segments.join(sep);
}

/**
 * Splits `text` into chunks where each chunk fits within `maxTokens`.
 *
 * @param text - The input text to split.
 * @param maxTokens - Maximum tokens allowed per chunk.
 * @param options - Optional configuration.
 * @returns Array of TextChunk objects with text, token estimate, and metadata.
 */
export function splitByTokens(
  text: string,
  maxTokens: number,
  options: SplitOptions = {}
): TextChunk[] {
  const { overlap = 50, boundary = "sentence", source } = options;

  if (!text.trim()) return [];
  if (maxTokens <= 0) throw new Error("maxTokens must be a positive integer");

  const segments = getSegments(text, boundary);
  const chunks: TextChunk[] = [];
  let currentSegments: string[] = [];
  let currentTokens = 0;
  let charCursor = 0;

  const flush = (): void => {
    if (currentSegments.length === 0) return;
    const chunkText = joinSegments(currentSegments, boundary);
    const startChar = charCursor - chunkText.length;
    chunks.push({
      text: chunkText,
      tokens: estimateTokens(chunkText),
      index: chunks.length,
      startChar: Math.max(0, startChar),
      endChar: charCursor,
      ...(source ? { source } : {}),
    });
  };

  const buildOverlap = (segs: string[]): string[] => {
    const overlapSegs: string[] = [];
    let overlapTokens = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      const t = estimateTokens(segs[i]);
      if (overlapTokens + t > overlap) break;
      overlapSegs.unshift(segs[i]);
      overlapTokens += t;
    }
    return overlapSegs;
  };

  for (const segment of segments) {
    const segTokens = estimateTokens(segment);

    // Single segment exceeds limit - force it as its own chunk.
    if (segTokens >= maxTokens) {
      if (currentSegments.length > 0) {
        flush();
        currentSegments = [];
        currentTokens = 0;
      }
      charCursor += segment.length;
      chunks.push({
        text: segment,
        tokens: segTokens,
        index: chunks.length,
        startChar: charCursor - segment.length,
        endChar: charCursor,
        ...(source ? { source } : {}),
      });
      continue;
    }

    if (currentTokens + segTokens > maxTokens) {
      flush();
      const overlapSegs = buildOverlap(currentSegments);
      currentSegments = overlapSegs;
      currentTokens = overlapSegs.reduce((acc, s) => acc + estimateTokens(s), 0);
    }

    currentSegments.push(segment);
    currentTokens += segTokens;
    charCursor += segment.length + 1; // +1 for separator
  }

  // Flush remaining segments.
  if (currentSegments.length > 0) flush();

  return chunks;
}
