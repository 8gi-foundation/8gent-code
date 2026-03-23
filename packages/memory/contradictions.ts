/**
 * Contradiction Detection - finds conflicting memories deterministically.
 * No LLM needed - uses keyword matching and temporal analysis.
 */

import { Database } from "bun:sqlite";

export interface Contradiction {
  memoryA: { id: string; content: string; createdAt: number };
  memoryB: { id: string; content: string; createdAt: number };
  conflictType: "value" | "temporal" | "negation";
  confidence: number;
}

const NEGATION_WORDS = ["not", "never", "no longer", "stopped", "removed", "deleted", "isn't", "doesn't", "won't"];

export function detectContradictions(db: Database): Contradiction[] {
  const rows = db.prepare(
    "SELECT id, content_text, created_at FROM memories WHERE deleted_at IS NULL AND importance >= 0.3 ORDER BY created_at DESC LIMIT 500"
  ).all() as Array<{ id: string; content_text: string; created_at: number }>;

  const contradictions: Contradiction[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];

      const aLower = a.content_text.toLowerCase();
      const bLower = b.content_text.toLowerCase();

      // Skip if texts are too short or identical
      if (aLower.length < 10 || bLower.length < 10) continue;
      if (aLower === bLower) continue;

      // Check for negation contradiction
      const negation = checkNegation(aLower, bLower);
      if (negation > 0) {
        contradictions.push({
          memoryA: { id: a.id, content: a.content_text, createdAt: a.created_at },
          memoryB: { id: b.id, content: b.content_text, createdAt: b.created_at },
          conflictType: "negation",
          confidence: negation,
        });
        continue;
      }

      // Check for value contradiction (same subject, different predicate)
      const value = checkValueConflict(aLower, bLower);
      if (value > 0) {
        contradictions.push({
          memoryA: { id: a.id, content: a.content_text, createdAt: a.created_at },
          memoryB: { id: b.id, content: b.content_text, createdAt: b.created_at },
          conflictType: "value",
          confidence: value,
        });
      }
    }
  }

  return contradictions;
}

function checkNegation(a: string, b: string): number {
  // Check if one text is the negation of the other
  for (const neg of NEGATION_WORDS) {
    // If A has negation word and B doesn't (or vice versa), and they share significant words
    const aHasNeg = a.includes(neg);
    const bHasNeg = b.includes(neg);
    if (aHasNeg !== bHasNeg) {
      // Remove the negation word and compare remaining content
      const aClean = a.replace(neg, "").trim();
      const bClean = b.replace(neg, "").trim();
      const overlap = wordOverlap(aClean, bClean);
      if (overlap > 0.5) return overlap;
    }
  }
  return 0;
}

function checkValueConflict(a: string, b: string): number {
  // Pattern: "X is Y" vs "X is Z" where Y !== Z
  const isPatternA = a.match(/(.+?)\s+(?:is|are|was|were|uses?|prefer)\s+(.+)/);
  const isPatternB = b.match(/(.+?)\s+(?:is|are|was|were|uses?|prefer)\s+(.+)/);

  if (isPatternA && isPatternB) {
    const subjectOverlap = wordOverlap(isPatternA[1], isPatternB[1]);
    if (subjectOverlap > 0.6) {
      const valueOverlap = wordOverlap(isPatternA[2], isPatternB[2]);
      // Same subject but different value = contradiction
      if (valueOverlap < 0.3) return subjectOverlap * 0.8;
    }
  }
  return 0;
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

export function resolveContradiction(c: Contradiction): string {
  // Newer memory wins by default
  return c.memoryA.createdAt > c.memoryB.createdAt ? c.memoryA.id : c.memoryB.id;
}
