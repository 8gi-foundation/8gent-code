/**
 * 8gent Code - Skill Registry
 *
 * Manages imported skills with minimal token footprint.
 * Skills go through quarantine before being registered here.
 *
 * Token Efficiency Strategy:
 * 1. Store full skill data on disk
 * 2. Keep only summaries in memory
 * 3. Agent queries for capabilities, gets summaries
 * 4. Load full skill only when invoking
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AbstractedSkill } from "../quarantine/abstractor.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillSummary {
  name: string;
  description: string;
  capabilities: string[];
  triggers: string[];
  tokenEstimate: number;
}

export interface SkillQuery {
  capability?: string;
  trigger?: string;
  namePattern?: string;
  maxResults?: number;
}

// ============================================================================
// Skill Registry
// ============================================================================

export class SkillRegistry {
  private summaries: Map<string, SkillSummary> = new Map();
  private skillsDir: string;
  private indexPath: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || path.join(os.homedir(), ".8gent", "skills");
    this.indexPath = path.join(this.skillsDir, ".index.json");
    this.ensureDirectory();
    this.loadIndex();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  private loadIndex(): void {
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
        for (const summary of data.skills || []) {
          this.summaries.set(summary.name, summary);
        }
      } catch (err) {
        console.warn("[skill-registry] Failed to load index:", err);
      }
    }
  }

  private saveIndex(): void {
    const data = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      skillCount: this.summaries.size,
      skills: Array.from(this.summaries.values()),
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  /**
   * Register an abstracted skill from quarantine
   */
  register(skill: AbstractedSkill): void {
    const summary: SkillSummary = {
      name: skill.name,
      description: skill.description,
      capabilities: skill.capabilities,
      triggers: skill.triggers,
      tokenEstimate: skill.tokenEstimate,
    };

    this.summaries.set(skill.name, summary);
    this.saveIndex();

    console.log(`[skill-registry] ✅ Registered: ${skill.name} (${skill.tokenEstimate} tokens)`);
  }

  /**
   * Unregister a skill
   */
  unregister(name: string): boolean {
    const deleted = this.summaries.delete(name);
    if (deleted) {
      // Remove skill file
      const skillPath = path.join(this.skillsDir, `${name.toLowerCase().replace(/\s+/g, "-")}.md`);
      if (fs.existsSync(skillPath)) {
        fs.unlinkSync(skillPath);
      }
      this.saveIndex();
      console.log(`[skill-registry] 🗑️ Unregistered: ${name}`);
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Querying (Token-Efficient)
  // --------------------------------------------------------------------------

  /**
   * Get minimal list for agent context
   * Format: "- skillname: description"
   */
  formatForAgent(): string {
    return Array.from(this.summaries.values())
      .map(s => `- ${s.name}: ${s.description.slice(0, 60)}`)
      .join("\n");
  }

  /**
   * Query skills by capability
   */
  findByCapability(capability: string): SkillSummary[] {
    return Array.from(this.summaries.values())
      .filter(s => s.capabilities.includes(capability));
  }

  /**
   * Query skills by trigger
   */
  findByTrigger(trigger: string): SkillSummary[] {
    const triggerLower = trigger.toLowerCase();
    return Array.from(this.summaries.values())
      .filter(s => s.triggers.some(t => t.includes(triggerLower)));
  }

  /**
   * Search skills by name pattern
   */
  search(pattern: string): SkillSummary[] {
    const regex = new RegExp(pattern, "i");
    return Array.from(this.summaries.values())
      .filter(s => regex.test(s.name) || regex.test(s.description));
  }

  /**
   * Combined query
   */
  query(q: SkillQuery): SkillSummary[] {
    let results = Array.from(this.summaries.values());

    if (q.capability) {
      results = results.filter(s => s.capabilities.includes(q.capability!));
    }

    if (q.trigger) {
      const triggerLower = q.trigger.toLowerCase();
      results = results.filter(s => s.triggers.some(t => t.includes(triggerLower)));
    }

    if (q.namePattern) {
      const regex = new RegExp(q.namePattern, "i");
      results = results.filter(s => regex.test(s.name) || regex.test(s.description));
    }

    return results.slice(0, q.maxResults || 10);
  }

  /**
   * Get all capabilities across all skills
   */
  listCapabilities(): string[] {
    const caps = new Set<string>();
    for (const summary of this.summaries.values()) {
      for (const cap of summary.capabilities) {
        caps.add(cap);
      }
    }
    return Array.from(caps).sort();
  }

  /**
   * Get skill summary by name
   */
  getSummary(name: string): SkillSummary | undefined {
    return this.summaries.get(name);
  }

  /**
   * Load full skill content (when actually needed)
   */
  loadFullSkill(name: string): string | null {
    const skillPath = path.join(this.skillsDir, `${name.toLowerCase().replace(/\s+/g, "-")}.md`);
    if (fs.existsSync(skillPath)) {
      return fs.readFileSync(skillPath, "utf-8");
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  get size(): number {
    return this.summaries.size;
  }

  getStats(): {
    skillCount: number;
    totalTokens: number;
    capabilities: number;
    avgTokensPerSkill: number;
  } {
    const skills = Array.from(this.summaries.values());
    const totalTokens = skills.reduce((sum, s) => sum + s.tokenEstimate, 0);
    const capabilities = new Set(skills.flatMap(s => s.capabilities)).size;

    return {
      skillCount: skills.length,
      totalTokens,
      capabilities,
      avgTokensPerSkill: skills.length > 0 ? Math.round(totalTokens / skills.length) : 0,
    };
  }

  /**
   * Rebuild index from skill files
   */
  rebuildIndex(): void {
    this.summaries.clear();

    const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith(".md"));

    for (const file of files) {
      const filePath = path.join(this.skillsDir, file);
      const content = fs.readFileSync(filePath, "utf-8");

      // Parse frontmatter
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) continue;

      const frontmatter: Record<string, string> = {};
      for (const line of match[1].split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let val = line.slice(colonIdx + 1).trim();
          // Handle arrays
          if (val.startsWith("[")) {
            frontmatter[key] = val;
          } else {
            frontmatter[key] = val.replace(/^['"]|['"]$/g, "");
          }
        }
      }

      if (frontmatter.name) {
        const summary: SkillSummary = {
          name: frontmatter.name,
          description: frontmatter.description || "",
          capabilities: this.parseArray(frontmatter.capabilities),
          triggers: this.parseArray(frontmatter.triggers),
          tokenEstimate: Math.ceil(content.length / 4),
        };
        this.summaries.set(summary.name, summary);
      }
    }

    this.saveIndex();
    console.log(`[skill-registry] 🔄 Rebuilt index: ${this.summaries.size} skills`);
  }

  private parseArray(val: string | undefined): string[] {
    if (!val) return [];
    if (val.startsWith("[") && val.endsWith("]")) {
      return val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    }
    return [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let registryInstance: SkillRegistry | null = null;

export function getSkillRegistry(skillsDir?: string): SkillRegistry {
  if (!registryInstance) {
    registryInstance = new SkillRegistry(skillsDir);
  }
  return registryInstance;
}

export function resetSkillRegistry(): void {
  registryInstance = null;
}
