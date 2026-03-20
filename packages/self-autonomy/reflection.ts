/**
 * Post-session reflection — distills what happened into a SessionReflection
 * and persists it to the evolution DB.
 *
 * Inspired by Hermes (ArcadeAI) self-evolution patterns, rebuilt from scratch.
 */

import { saveReflection } from "./evolution-db.js";
import type { SessionReflection } from "./evolution-db.js";

// ============================================
// Session Data Input
// ============================================

export interface SessionData {
  sessionId: string;
  /** Tool names called during the session */
  toolsUsed: string[];
  /** Raw error strings encountered */
  errors: string[];
  /** Free-text notes the agent appended during the run */
  notes: string[];
  /** Number of successful tool calls */
  successfulCalls: number;
  /** Total tool calls (success + failure) */
  totalCalls: number;
}

// ============================================
// Core Reflection Logic
// ============================================

/**
 * Reflect on a completed session.
 * Extracts reusable patterns, summarises errors, and stores the result.
 */
export function reflect(sessionData: SessionData): SessionReflection {
  const { sessionId, toolsUsed, errors, notes, successfulCalls, totalCalls } = sessionData;

  const successRate = totalCalls > 0 ? successfulCalls / totalCalls : 1;

  // Deduplicate tools
  const uniqueTools = [...new Set(toolsUsed)];

  // Normalise errors to patterns (strip file paths and line numbers)
  const errorPatterns = [...new Set(
    errors.map(e =>
      e
        .replace(/\/[^\s]+/g, "<path>")
        .replace(/\d+:\d+/g, "<loc>")
        .replace(/\b\d{5,}\b/g, "<id>")
        .slice(0, 120),
    ),
  )];

  // Extract patterns from agent notes (lines starting with "PATTERN:" or "NOTE:")
  const patternsObserved = notes
    .filter(n => /^(PATTERN|OBSERVE|NOTE):/i.test(n.trim()))
    .map(n => n.replace(/^(PATTERN|OBSERVE|NOTE):\s*/i, "").trim());

  // Extract skills from notes (lines starting with "SKILL:" or "LEARNED:")
  const skillsLearned = notes
    .filter(n => /^(SKILL|LEARNED):/i.test(n.trim()))
    .map(n => n.replace(/^(SKILL|LEARNED):\s*/i, "").trim());

  // Infer implicit patterns from tool usage
  const implicitPatterns = inferPatterns(uniqueTools, errorPatterns);
  const allPatterns = [...new Set([...patternsObserved, ...implicitPatterns])];

  const reflection: SessionReflection = {
    sessionId,
    timestamp: new Date().toISOString(),
    toolsUsed: uniqueTools,
    errorsEncountered: errorPatterns,
    patternsObserved: allPatterns,
    skillsLearned,
    successRate,
  };

  saveReflection(reflection);
  return reflection;
}

// ============================================
// Pattern Inference Heuristics
// ============================================

function inferPatterns(tools: string[], errors: string[]): string[] {
  const patterns: string[] = [];

  // Tool co-occurrence patterns
  if (tools.includes("read_file") && tools.includes("edit_file")) {
    patterns.push("Read before editing: always read the current file state first");
  }
  if (tools.includes("bash") && errors.some(e => e.includes("not found"))) {
    patterns.push("Command not found: check PATH or use full binary path");
  }
  if (tools.includes("bash") && tools.includes("read_file") && tools.length > 4) {
    patterns.push("Mixed bash + file tools: prefer dedicated file tools over bash cat/grep");
  }

  // Error-pattern heuristics
  if (errors.some(e => e.includes("ENOENT") || e.includes("no such file"))) {
    patterns.push("File not found: verify path exists before reading or writing");
  }
  if (errors.some(e => e.includes("TypeScript") || e.includes("TS2"))) {
    patterns.push("TypeScript error: check types and imports before running");
  }
  if (errors.some(e => e.includes("Cannot find module"))) {
    patterns.push("Module resolution error: check package.json exports and tsconfig paths");
  }

  return patterns;
}
