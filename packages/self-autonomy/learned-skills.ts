/**
 * Learned Skills — store, retrieve, and reinforce patterns that persist
 * across sessions.  The key interface for the evolution loop.
 *
 * Inspired by Hermes (ArcadeAI) self-evolution patterns, rebuilt from scratch.
 */

import * as crypto from "crypto";
import {
  saveSkill,
  getSkillById,
  getAllSkills,
  querySkillsByTrigger,
  updateSkillStats,
} from "./evolution-db.js";
import type { LearnedSkill } from "./evolution-db.js";

export type { LearnedSkill } from "./evolution-db.js";

// ============================================
// Public API
// ============================================

/**
 * Create and persist a new learned skill.
 * If a skill with the same trigger already exists, bumps its confidence instead.
 */
export function learnSkill(
  trigger: string,
  action: string,
  source: string = "manual",
): LearnedSkill {
  // Check for near-duplicate trigger (exact match)
  const existing = querySkillsByTrigger(trigger).find(
    s => s.trigger.toLowerCase() === trigger.toLowerCase(),
  );

  if (existing) {
    // Reinforce rather than duplicate
    reinforceSkill(existing.id, true);
    return getSkillById(existing.id)!;
  }

  const skill: LearnedSkill = {
    id: crypto.randomUUID(),
    trigger,
    action,
    confidence: 0.5,
    timesUsed: 0,
    lastUsed: new Date().toISOString(),
    source,
  };

  saveSkill(skill);
  return skill;
}

/**
 * Retrieve the most relevant learned skills for a given task description.
 * Scores by keyword overlap + confidence. Returns top `limit` results.
 */
export function getRelevantSkills(
  taskDescription: string,
  limit: number = 5,
): LearnedSkill[] {
  const allSkills = getAllSkills();
  if (allSkills.length === 0) return [];

  const words = tokenize(taskDescription);

  const scored = allSkills
    .map(skill => {
      const triggerWords = tokenize(skill.trigger);
      const actionWords = tokenize(skill.action);
      const overlap = words.filter(
        w => triggerWords.includes(w) || actionWords.includes(w),
      ).length;
      // Weight: keyword overlap * 0.6 + confidence * 0.4
      const score = overlap * 0.6 + skill.confidence * 0.4;
      return { skill, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ skill }) => skill);
}

/**
 * Update a skill's confidence based on whether it helped.
 * Calls through to evolution-db updateSkillStats.
 */
export function reinforceSkill(skillId: string, success: boolean): void {
  updateSkillStats(skillId, success);
}

/**
 * Format relevant skills as a prompt prefix for injection into agent context.
 * Returns empty string if no skills found.
 */
export function buildSkillsContext(taskDescription: string, limit: number = 3): string {
  const skills = getRelevantSkills(taskDescription, limit);
  if (skills.length === 0) return "";

  const lines = [
    "## Learned skills (from previous sessions)",
    ...skills.map(
      s => `- When: ${s.trigger}\n  Do: ${s.action}  [confidence: ${(s.confidence * 100).toFixed(0)}%]`,
    ),
    "",
  ];
  return lines.join("\n");
}

// ============================================
// Helpers
// ============================================

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "when", "then",
  "are", "was", "has", "have", "had", "will", "can", "not", "but",
]);
