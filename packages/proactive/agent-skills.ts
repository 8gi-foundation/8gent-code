/**
 * 8gent - Agent Skills Registry
 *
 * Pattern extracted from Linear Agent Skills (March 2026).
 * Save successful task patterns as named, reusable workflows.
 * Skills can be triggered manually or auto-matched to incoming tasks.
 */

import { join } from "path";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  /** Keywords for matching incoming tasks */
  triggerPatterns: string[];
  /** Prompt template the agent should follow */
  template: string;
  tools?: string[];
  useCount: number;
  /** Rolling average success rating (0-1) */
  successRate: number;
  createdAt: string;
  lastUsedAt?: string;
  source: "manual" | "learned";
}

export interface SkillMatch {
  skill: AgentSkill;
  confidence: number;
  matchedPatterns: string[];
}

const DATA_DIR = join(process.env.HOME || "~", ".8gent");
const SKILLS_PATH = join(DATA_DIR, "agent-skills.json");

async function readSkills(): Promise<AgentSkill[]> {
  try {
    return JSON.parse(await Bun.file(SKILLS_PATH).text()) as AgentSkill[];
  } catch {
    return [];
  }
}

async function writeSkills(skills: AgentSkill[]): Promise<void> {
  try {
    await Bun.write(SKILLS_PATH, JSON.stringify(skills, null, 2));
  } catch {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(SKILLS_PATH, JSON.stringify(skills, null, 2));
  }
}

/** Score how well a skill matches a task description (keyword overlap, no LLM). */
function scoreMatch(skill: AgentSkill, task: string): SkillMatch | null {
  const taskLower = task.toLowerCase();
  const taskWords = new Set(taskLower.split(/\s+/));
  const matchedPatterns: string[] = [];
  let totalScore = 0;

  for (const pattern of skill.triggerPatterns) {
    const patternLower = pattern.toLowerCase();
    if (taskLower.includes(patternLower)) {
      matchedPatterns.push(pattern);
      totalScore += 1.0;
      continue;
    }
    const patternWords = patternLower.split(/\s+/);
    const overlap = patternWords.filter((w) => taskWords.has(w)).length;
    if (overlap > 0) {
      const ratio = overlap / patternWords.length;
      if (ratio >= 0.5) {
        matchedPatterns.push(pattern);
        totalScore += ratio * 0.6;
      }
    }
  }

  if (matchedPatterns.length === 0) return null;

  const rawConfidence = Math.min(1.0, totalScore / skill.triggerPatterns.length);
  const usageBoost = Math.min(0.1, skill.useCount * 0.01);
  const successBoost = skill.successRate * 0.15;
  const confidence = Math.min(1.0, rawConfidence + usageBoost + successBoost);
  return { skill, confidence, matchedPatterns };
}

/** Register a new skill or update an existing one (preserves stats on update). */
export async function registerSkill(
  skill: Omit<AgentSkill, "useCount" | "successRate" | "createdAt">
): Promise<AgentSkill> {
  const skills = await readSkills();
  const idx = skills.findIndex((s) => s.id === skill.id);
  const full: AgentSkill = {
    ...skill,
    useCount: 0,
    successRate: 0,
    createdAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    full.useCount = skills[idx].useCount;
    full.successRate = skills[idx].successRate;
    full.createdAt = skills[idx].createdAt;
    skills[idx] = full;
  } else {
    skills.push(full);
  }
  await writeSkills(skills);
  return full;
}

/** Save a skill from a successful session (the "learned" path). */
export async function learnSkill(
  name: string,
  description: string,
  template: string,
  triggerPatterns: string[],
  tools?: string[]
): Promise<AgentSkill> {
  const id = `learned-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  return registerSkill({ id, name, description, triggerPatterns, template, tools, source: "learned" });
}

/** Find best matching skill(s) for a task. Sorted by confidence, filtered above threshold. */
export async function matchSkills(
  task: string,
  threshold = 0.3,
  maxResults = 3
): Promise<SkillMatch[]> {
  const skills = await readSkills();
  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    const match = scoreMatch(skill, task);
    if (match && match.confidence >= threshold) matches.push(match);
  }
  return matches.sort((a, b) => b.confidence - a.confidence).slice(0, maxResults);
}

/** Record that a skill was used and whether it succeeded. */
export async function recordUsage(skillId: string, success: boolean): Promise<void> {
  const skills = await readSkills();
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return;
  skill.useCount += 1;
  skill.successRate =
    (skill.successRate * (skill.useCount - 1) + (success ? 1 : 0)) / skill.useCount;
  skill.lastUsedAt = new Date().toISOString();
  await writeSkills(skills);
}

/** List all registered skills. */
export async function listSkills(): Promise<AgentSkill[]> {
  return readSkills();
}

/** Remove a skill by ID. */
export async function removeSkill(id: string): Promise<boolean> {
  const skills = await readSkills();
  const filtered = skills.filter((s) => s.id !== id);
  if (filtered.length === skills.length) return false;
  await writeSkills(filtered);
  return true;
}

/** Get a skill by ID. */
export async function getSkill(id: string): Promise<AgentSkill | null> {
  const skills = await readSkills();
  return skills.find((s) => s.id === id) || null;
}
