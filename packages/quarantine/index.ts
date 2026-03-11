/**
 * 8gent Code - Skill Quarantine System
 *
 * Trust no one. Not even ourselves.
 *
 * Flow:
 * External Repo → Clone to Quarantine → Security Scan → Abstract → Release to Toolshed
 *
 * Directory structure:
 * ~/.8gent/quarantine/
 * ├── pending/      # Awaiting scan
 * ├── scanned/      # Passed scan, awaiting abstraction
 * ├── approved/     # Ready for release
 * └── rejected/     # Failed (kept for forensics)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawn } from "child_process";
import { scanSkill, type ScanResult, type Verdict } from "./scanner/security-scanner.js";
import { abstractSkill, type AbstractedSkill } from "./abstractor.js";

// ============================================================================
// Types
// ============================================================================

export interface QuarantineEntry {
  id: string;
  name: string;
  source: string; // URL or local path
  sourceType: "github" | "local" | "npm" | "unknown";
  status: "pending" | "scanned" | "abstracted" | "approved" | "rejected";
  quarantinedAt: Date;
  scanResult?: ScanResult;
  abstractedSkill?: AbstractedSkill;
  rejectionReason?: string;
  releasedAt?: Date;
}

export interface QuarantineConfig {
  quarantineDir: string;
  autoReject: boolean; // Auto-reject CRITICAL findings
  autoApprove: boolean; // Auto-approve PASS verdicts
  maxPendingDays: number; // Auto-cleanup after N days
}

// ============================================================================
// Quarantine Manager
// ============================================================================

export class QuarantineManager {
  private config: QuarantineConfig;
  private entries: Map<string, QuarantineEntry> = new Map();
  private registryPath: string;

  constructor(config?: Partial<QuarantineConfig>) {
    this.config = {
      quarantineDir: config?.quarantineDir || path.join(os.homedir(), ".8gent", "quarantine"),
      autoReject: config?.autoReject ?? true,
      autoApprove: config?.autoApprove ?? false, // Default: require human review
      maxPendingDays: config?.maxPendingDays ?? 30,
    };

    this.registryPath = path.join(this.config.quarantineDir, "registry.json");
    this.ensureDirectories();
    this.loadRegistry();
  }

  // --------------------------------------------------------------------------
  // Directory Management
  // --------------------------------------------------------------------------

  private ensureDirectories(): void {
    const dirs = ["pending", "scanned", "approved", "rejected"];
    for (const dir of dirs) {
      const fullPath = path.join(this.config.quarantineDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
  }

  private loadRegistry(): void {
    if (fs.existsSync(this.registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
        for (const entry of data.entries || []) {
          entry.quarantinedAt = new Date(entry.quarantinedAt);
          if (entry.releasedAt) entry.releasedAt = new Date(entry.releasedAt);
          this.entries.set(entry.id, entry);
        }
      } catch (err) {
        console.warn("[quarantine] Failed to load registry:", err);
      }
    }
  }

  private saveRegistry(): void {
    const data = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };
    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }

  // --------------------------------------------------------------------------
  // Quarantine Operations
  // --------------------------------------------------------------------------

  /**
   * Quarantine an external skill for review
   */
  async quarantine(source: string, name?: string): Promise<QuarantineEntry> {
    const id = this.generateId();
    const skillName = name || this.extractName(source);
    const sourceType = this.detectSourceType(source);

    const entry: QuarantineEntry = {
      id,
      name: skillName,
      source,
      sourceType,
      status: "pending",
      quarantinedAt: new Date(),
    };

    // Clone/copy to quarantine
    const targetDir = path.join(this.config.quarantineDir, "pending", id);
    await this.fetchSource(source, sourceType, targetDir);

    // Create metadata
    const metaPath = path.join(targetDir, "meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({
      id,
      name: skillName,
      source,
      sourceType,
      quarantinedAt: entry.quarantinedAt.toISOString(),
      sourceHash: this.hashDirectory(targetDir),
    }, null, 2));

    this.entries.set(id, entry);
    this.saveRegistry();

    console.log(`[quarantine] 📥 Quarantined: ${skillName} (${id})`);
    return entry;
  }

  /**
   * Run security scan on quarantined skill
   */
  async scan(id: string): Promise<ScanResult> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry not found: ${id}`);

    const skillDir = path.join(this.config.quarantineDir, "pending", id);
    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill directory not found: ${skillDir}`);
    }

    console.log(`[quarantine] 🔍 Scanning: ${entry.name}...`);
    const result = await scanSkill(skillDir);

    entry.scanResult = result;
    entry.status = "scanned";

    // Move to scanned directory
    const newDir = path.join(this.config.quarantineDir, "scanned", id);
    fs.renameSync(skillDir, newDir);

    // Auto-reject on CRITICAL
    if (this.config.autoReject && result.verdict === "FAIL") {
      await this.reject(id, "Auto-rejected: Security scan failed with CRITICAL findings");
      return result;
    }

    // Auto-approve on PASS (if enabled)
    if (this.config.autoApprove && result.verdict === "PASS") {
      await this.abstract(id);
      await this.release(id);
    }

    this.saveRegistry();
    return result;
  }

  /**
   * Abstract skill to 8gent conventions
   */
  async abstract(id: string): Promise<AbstractedSkill> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry not found: ${id}`);
    if (entry.status !== "scanned") {
      throw new Error(`Skill must be scanned before abstraction. Current status: ${entry.status}`);
    }

    const skillDir = path.join(this.config.quarantineDir, "scanned", id);

    console.log(`[quarantine] 🔧 Abstracting: ${entry.name}...`);
    const abstracted = await abstractSkill(skillDir, entry.name);

    entry.abstractedSkill = abstracted;
    entry.status = "abstracted";

    // Move to approved
    const approvedDir = path.join(this.config.quarantineDir, "approved", id);
    fs.renameSync(skillDir, approvedDir);

    // Write abstracted skill
    const abstractedPath = path.join(approvedDir, "abstracted.json");
    fs.writeFileSync(abstractedPath, JSON.stringify(abstracted, null, 2));

    this.saveRegistry();
    return abstracted;
  }

  /**
   * Release approved skill to toolshed
   */
  async release(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry not found: ${id}`);
    if (entry.status !== "abstracted" && entry.status !== "approved") {
      throw new Error(`Skill must be abstracted before release. Current status: ${entry.status}`);
    }

    const approvedDir = path.join(this.config.quarantineDir, "approved", id);
    const skillsDir = path.join(os.homedir(), ".8gent", "skills");

    // Ensure skills directory exists
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    // Generate 8gent-compatible skill file
    const skillContent = this.generateSkillFile(entry);
    const skillPath = path.join(skillsDir, `${entry.name.toLowerCase().replace(/\s+/g, "-")}.md`);
    fs.writeFileSync(skillPath, skillContent);

    entry.status = "approved";
    entry.releasedAt = new Date();
    this.saveRegistry();

    console.log(`[quarantine] ✅ Released: ${entry.name} → ${skillPath}`);
  }

  /**
   * Reject quarantined skill
   */
  async reject(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry not found: ${id}`);

    // Find current location
    const possibleDirs = ["pending", "scanned", "approved"];
    let currentDir: string | null = null;

    for (const dir of possibleDirs) {
      const checkPath = path.join(this.config.quarantineDir, dir, id);
      if (fs.existsSync(checkPath)) {
        currentDir = checkPath;
        break;
      }
    }

    if (currentDir) {
      const rejectedDir = path.join(this.config.quarantineDir, "rejected", id);
      fs.renameSync(currentDir, rejectedDir);

      // Add rejection metadata
      const rejectMeta = path.join(rejectedDir, "rejection.json");
      fs.writeFileSync(rejectMeta, JSON.stringify({
        reason,
        rejectedAt: new Date().toISOString(),
        scanResult: entry.scanResult,
      }, null, 2));
    }

    entry.status = "rejected";
    entry.rejectionReason = reason;
    this.saveRegistry();

    console.log(`[quarantine] 🚫 Rejected: ${entry.name} - ${reason}`);
  }

  /**
   * List all quarantined entries
   */
  list(status?: QuarantineEntry["status"]): QuarantineEntry[] {
    const entries = Array.from(this.entries.values());
    if (status) {
      return entries.filter(e => e.status === status);
    }
    return entries;
  }

  /**
   * Get entry by ID
   */
  get(id: string): QuarantineEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Clean up old rejected entries
   */
  cleanup(olderThanDays: number = 30): number {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let removed = 0;

    for (const [id, entry] of this.entries) {
      if (entry.status === "rejected" && entry.quarantinedAt.getTime() < cutoff) {
        const rejectedDir = path.join(this.config.quarantineDir, "rejected", id);
        if (fs.existsSync(rejectedDir)) {
          fs.rmSync(rejectedDir, { recursive: true, force: true });
        }
        this.entries.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.saveRegistry();
      console.log(`[quarantine] 🧹 Cleaned up ${removed} old rejected entries`);
    }

    return removed;
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  private generateId(): string {
    return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private extractName(source: string): string {
    // GitHub URL
    if (source.includes("github.com")) {
      const parts = source.split("/");
      return parts[parts.length - 1].replace(".git", "").replace(/-/g, "_");
    }
    // Local path
    if (source.startsWith("/") || source.startsWith("~")) {
      return path.basename(source);
    }
    // NPM package
    if (source.includes("@") || /^[a-z0-9-]+$/.test(source)) {
      return source.replace(/@/g, "").replace(/\//g, "_");
    }
    return "unknown_skill";
  }

  private detectSourceType(source: string): QuarantineEntry["sourceType"] {
    if (source.includes("github.com") || source.includes("gitlab.com")) {
      return "github";
    }
    if (source.startsWith("/") || source.startsWith("~") || source.startsWith(".")) {
      return "local";
    }
    if (source.includes("@") || /^[a-z0-9-]+$/.test(source)) {
      return "npm";
    }
    return "unknown";
  }

  private async fetchSource(source: string, type: QuarantineEntry["sourceType"], targetDir: string): Promise<void> {
    fs.mkdirSync(targetDir, { recursive: true });

    switch (type) {
      case "github":
        // Clone with depth 1
        execSync(`git clone --depth 1 "${source}" "${targetDir}/source"`, {
          stdio: "pipe",
        });
        break;

      case "local":
        // Copy local directory
        const realSource = source.replace("~", os.homedir());
        execSync(`cp -r "${realSource}" "${targetDir}/source"`, {
          stdio: "pipe",
        });
        break;

      case "npm":
        // Download npm package
        execSync(`cd "${targetDir}" && npm pack "${source}" --pack-destination .`, {
          stdio: "pipe",
        });
        // Extract
        const tarball = fs.readdirSync(targetDir).find(f => f.endsWith(".tgz"));
        if (tarball) {
          execSync(`cd "${targetDir}" && tar -xzf "${tarball}" && mv package source`, {
            stdio: "pipe",
          });
        }
        break;

      default:
        throw new Error(`Unknown source type: ${type}`);
    }
  }

  private hashDirectory(dir: string): string {
    try {
      const output = execSync(
        `find "${dir}" -type f -exec sha256sum {} \\; | sort | sha256sum | cut -d' ' -f1`,
        { stdio: "pipe" }
      );
      return output.toString().trim().slice(0, 16);
    } catch {
      return "unknown";
    }
  }

  private generateSkillFile(entry: QuarantineEntry): string {
    const skill = entry.abstractedSkill;
    if (!skill) {
      throw new Error("No abstracted skill data");
    }

    return `---
name: ${skill.name}
description: ${skill.description}
tools: [${skill.tools.join(", ")}]
triggers: [${skill.triggers.join(", ")}]
source: ${entry.source}
quarantine_id: ${entry.id}
imported_at: ${new Date().toISOString()}
---

# ${skill.name}

${skill.description}

## Instructions

${skill.instructions}

## Tools

${skill.tools.map(t => `- \`${t}\``).join("\n")}

## Security Notes

- **Scan verdict:** ${entry.scanResult?.verdict || "N/A"}
- **Source:** ${entry.source}
- **Quarantine ID:** ${entry.id}

---
*Imported via 8gent Quarantine System*
`;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let quarantineInstance: QuarantineManager | null = null;

export function getQuarantineManager(config?: Partial<QuarantineConfig>): QuarantineManager {
  if (!quarantineInstance) {
    quarantineInstance = new QuarantineManager(config);
  }
  return quarantineInstance;
}

export function resetQuarantineManager(): void {
  quarantineInstance = null;
}

// Re-export types
export type { ScanResult, Verdict, AbstractedSkill };
