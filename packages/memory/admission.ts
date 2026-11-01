/**
 * Memory admission — the write-path trust gate.
 *
 * A memory is re-injected into the prompt on every later session, so a poisoned
 * memory is PERSISTENT prompt injection. The check therefore belongs at write
 * time, before anything can be persisted.
 *
 * This module does not sanitise anything itself. It delegates to the existing
 * sanitisers — `sanitize()` (invisible Unicode) and `redact()` (credentials) —
 * and adds the one judgement neither of them can make: whether the content is
 * an instruction addressed to the agent.
 *
 * See docs/specs/MEMORY-TRUST.md for the rule this implements.
 */

import type { Memory } from "./types.js";
import { redact } from "./redact.js";
import { sanitize } from "./sanitize.js";

/** Thrown when content may not be stored. Callers must surface this, never swallow it. */
export class MemoryTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryTrustError";
  }
}

/**
 * Imperative phrases addressed to the agent rather than assertions about the world.
 *
 * Deliberately high-precision: ordinary procedure steps ("Run the tests") must not
 * match, so only the classic injection imperatives are listed. The accepted cost is
 * documented in MEMORY-TRUST.md — a note *about* prompt injection is rejected too.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instruction|prompt|rule|direction)s?\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+this\s+to|reveal\s+this\s+to)\s+the\s+user\b/i,
  /\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b/i,
  /\b(?:new|updated|revised)\s+instructions\s*:/i,
  /\boverride\s+(?:your|the|all)\s+(?:previous\s+)?(?:instructions|rules|system\s+prompt)\b/i,
];

/** Is this text an instruction addressed to the agent? */
export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Admit a caller-supplied string. Returns the storable text — secrets redacted,
 * invisible Unicode removed — or throws MemoryTrustError if it may not be stored.
 *
 * Order matters: `sanitize()` runs BEFORE the instruction check so that an
 * instruction obfuscated with invisible Unicode tags is de-obfuscated and then
 * caught, rather than slipping through as invisible text.
 */
export function admitText(text: string, context = "content"): string {
  const deobfuscated = sanitize(text);

  if (looksLikeInstruction(deobfuscated)) {
    throw new MemoryTrustError(
      `Refusing to store ${context}: it reads as an instruction addressed to the agent, ` +
        `not a fact about the world. Stored memories re-inject on every later session. ` +
        `Rewrite it as an assertion, or store it outside memory.`
    );
  }

  return redact(deobfuscated);
}

/**
 * Admit a Memory record before it reaches storage. Returns a record safe to
 * persist — secrets redacted, invisible Unicode removed — or throws.
 *
 * Runs over the serialised record so every string field is covered (including
 * nested procedure steps and tags) without enumerating the Memory union.
 */
export function admitMemory(candidate: Memory): Memory {
  const json = JSON.stringify(candidate);
  const cleaned = admitText(json, "memory");

  // Nothing changed — keep the caller's object as-is.
  if (cleaned === json) return candidate;

  try {
    // Reason for the cast: round-trip of a value we just serialised ourselves,
    // so the shape is structurally the same union JSON.parse cannot infer.
    return JSON.parse(cleaned) as unknown as Memory;
  } catch (err) {
    // Fail closed: never persist a payload we cannot re-read.
    throw new MemoryTrustError(
      `Refusing to store memory: sanitised payload is not valid JSON (${(err as Error).message})`
    );
  }
}
