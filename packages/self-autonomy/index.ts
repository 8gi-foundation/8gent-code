/**
 * 8gent Code - Self-Autonomy Engine
 *
 * Automatic versioning, self-healing, and self-modification.
 * Evolution, not vibes.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn, execSync } from "child_process";

// ============================================
// Types
// ============================================

export interface SelfAutonomyConfig {
  workingDirectory: string;
  autoGit: boolean;
  selfHeal: boolean;
  selfModify: boolean;
  verbose: boolean;
}

export interface GitState {
  branch: string;
  isClean: boolean;
  lastCommit: string;
  uncommittedFiles: string[];
}

export interface HealingPattern {
  count: number;
  lastSeen: string;
  solution: string;
  successRate: number;
}

export interface HealingMemory {
  patterns: Record<string, HealingPattern>;
}

export interface WorkingContext {
  session: string;
  started: string;
  project: string;
  branch: string;
  activeFiles: string[];
  currentTask: string;
  blockers: string[];
  notes: string;
}

export interface EvolutionEntry {
  timestamp: string;
  action: "MODIFY" | "CREATE" | "DELETE";
  file: string;
  reason: string;
  result: "SUCCESS" | "FAILED";
  branch: string;
  merged: boolean;
}

// ============================================
// Auto-Git
// ============================================

export class AutoGit {
  private cwd: string;
  private verbose: boolean;
  private branchPrefix = "8gent/";

  constructor(workingDirectory: string, verbose: boolean = false) {
    this.cwd = workingDirectory;
    this.verbose = verbose;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(`[8gent:git] ${message}`);
    }
  }

  private exec(command: string): string {
    try {
      return execSync(command, { cwd: this.cwd, encoding: "utf-8" }).trim();
    } catch (err) {
      return "";
    }
  }

  getState(): GitState {
    const branch = this.exec("git rev-parse --abbrev-ref HEAD");
    const status = this.exec("git status --porcelain");
    const lastCommit = this.exec("git log -1 --format=%H");
    const uncommittedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));

    return {
      branch,
      isClean: status === "",
      lastCommit,
      uncommittedFiles,
    };
  }

  isGitRepo(): boolean {
    return this.exec("git rev-parse --git-dir") !== "";
  }

  /**
   * Create a new branch for a task
   */
  createTaskBranch(taskSlug: string, type: "feat" | "fix" | "refactor" | "self" = "feat"): string {
    const timestamp = Date.now();
    const branchName = `${this.branchPrefix}${type}-${taskSlug}-${timestamp}`;

    // Stash if dirty
    const state = this.getState();
    if (!state.isClean) {
      this.exec(`git stash push -m "8gent-pre-branch-${timestamp}"`);
      this.log("Stashed uncommitted changes");
    }

    // Create and checkout branch
    this.exec(`git checkout -b ${branchName}`);
    this.log(`Created branch: ${branchName}`);

    return branchName;
  }

  /**
   * Auto-commit specific files with conventional commit message
   */
  commit(
    files: string[],
    type: "feat" | "fix" | "refactor" | "test" | "chore" | "docs",
    scope: string,
    message: string
  ): string | null {
    if (files.length === 0) return null;

    // Add specific files
    for (const file of files) {
      this.exec(`git add "${file}"`);
    }

    // Check if anything staged
    const staged = this.exec("git diff --cached --name-only");
    if (!staged) return null;

    // Create conventional commit
    const commitMessage = `${type}(${scope}): ${message}\n\n[8gent] Auto-commit`;
    this.exec(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);

    const commitHash = this.exec("git rev-parse HEAD");
    this.log(`Committed: ${type}(${scope}): ${message}`);

    return commitHash;
  }

  /**
   * Create a snapshot before risky operations
   */
  createSnapshot(label: string): string {
    const timestamp = Date.now();
    const snapshotName = `8gent-snapshot-${label}-${timestamp}`;
    this.exec(`git stash push -m "${snapshotName}"`);
    this.log(`Snapshot: ${snapshotName}`);
    return snapshotName;
  }

  /**
   * Restore from a snapshot
   */
  restoreSnapshot(snapshotName: string): boolean {
    const stashList = this.exec("git stash list");
    const lines = stashList.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(snapshotName)) {
        this.exec(`git stash pop stash@{${i}}`);
        this.log(`Restored: ${snapshotName}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Merge branch back to main
   */
  mergeBranch(branchName: string, deleteAfter: boolean = false): boolean {
    const currentBranch = this.getState().branch;

    // Switch to main
    this.exec("git checkout main");

    // Merge with no-ff
    const result = this.exec(`git merge ${branchName} --no-ff -m "Merge ${branchName}"`);

    if (result.includes("CONFLICT")) {
      // Abort merge on conflict
      this.exec("git merge --abort");
      this.exec(`git checkout ${currentBranch}`);
      this.log(`Merge conflict in ${branchName}`);
      return false;
    }

    if (deleteAfter) {
      this.exec(`git branch -d ${branchName}`);
    }

    this.log(`Merged ${branchName} to main`);
    return true;
  }

  /**
   * Rollback last commit
   */
  rollbackLastCommit(): void {
    this.exec("git reset --soft HEAD~1");
    this.log("Rolled back last commit");
  }

  /**
   * Return to main and discard branch
   */
  abortBranch(): void {
    const state = this.getState();
    if (state.branch !== "main" && state.branch.startsWith(this.branchPrefix)) {
      const branch = state.branch;
      this.exec("git checkout main");
      this.exec(`git branch -D ${branch}`);
      this.log(`Aborted branch: ${branch}`);
    }
  }
}

// ============================================
// Self-Heal
// ============================================

export class SelfHeal {
  private cwd: string;
  private verbose: boolean;
  private memoryPath: string;
  private memory: HealingMemory;

  constructor(workingDirectory: string, verbose: boolean = false) {
    this.cwd = workingDirectory;
    this.verbose = verbose;
    this.memoryPath = path.join(workingDirectory, ".8gent", "context", "healing.json");
    this.memory = this.loadMemory();
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(`[8gent:heal] ${message}`);
    }
  }

  private loadMemory(): HealingMemory {
    try {
      if (fs.existsSync(this.memoryPath)) {
        return JSON.parse(fs.readFileSync(this.memoryPath, "utf-8"));
      }
    } catch {}
    return { patterns: {} };
  }

  private saveMemory(): void {
    const dir = path.dirname(this.memoryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.memoryPath, JSON.stringify(this.memory, null, 2));
  }

  /**
   * Get known solution for an error pattern
   */
  getKnownSolution(errorPattern: string): string | null {
    const pattern = this.memory.patterns[errorPattern];
    if (pattern && pattern.successRate > 0.5) {
      this.log(`Known solution for ${errorPattern}: ${pattern.solution}`);
      return pattern.solution;
    }
    return null;
  }

  /**
   * Record a successful recovery
   */
  recordSuccess(errorPattern: string, solution: string): void {
    const existing = this.memory.patterns[errorPattern];
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      existing.successRate = (existing.successRate * (existing.count - 1) + 1) / existing.count;
    } else {
      this.memory.patterns[errorPattern] = {
        count: 1,
        lastSeen: new Date().toISOString(),
        solution,
        successRate: 1.0,
      };
    }
    this.saveMemory();
    this.log(`Learned: ${errorPattern} → ${solution}`);
  }

  /**
   * Record a failed recovery attempt
   */
  recordFailure(errorPattern: string, attemptedSolution: string): void {
    const existing = this.memory.patterns[errorPattern];
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      existing.successRate = (existing.successRate * (existing.count - 1)) / existing.count;
    }
    this.saveMemory();
  }

  /**
   * Get alternative strategies for an operation
   */
  getAlternatives(operation: string): string[] {
    const alternatives: Record<string, string[]> = {
      "npm-install": ["bun install", "pnpm install", "yarn install"],
      "npm-run": ["bun run", "pnpm run", "npx"],
      "file-read": ["cat", "head", "grep -l"],
      "search-code": ["grep -r", "rg", "ast-search"],
      "git-commit": ["git stash", "manual-save"],
    };

    return alternatives[operation] || [];
  }

  /**
   * Classify error severity
   */
  classifyError(error: string): "transient" | "recoverable" | "fixable" | "fatal" {
    const transientPatterns = [
      "ETIMEDOUT",
      "ECONNRESET",
      "rate limit",
      "503",
      "502",
      "timeout",
    ];

    const recoverablePatterns = [
      "not found",
      "no such file",
      "permission denied",
      "ENOENT",
      "invalid",
    ];

    const fatalPatterns = [
      "ENOMEM",
      "disk full",
      "authentication required",
      "credential",
    ];

    const errorLower = error.toLowerCase();

    for (const pattern of fatalPatterns) {
      if (errorLower.includes(pattern.toLowerCase())) return "fatal";
    }

    for (const pattern of transientPatterns) {
      if (errorLower.includes(pattern.toLowerCase())) return "transient";
    }

    for (const pattern of recoverablePatterns) {
      if (errorLower.includes(pattern.toLowerCase())) return "recoverable";
    }

    return "fixable";
  }
}

// ============================================
// Session Memory
// ============================================

export class SessionMemory {
  private cwd: string;
  private contextPath: string;
  private verbose: boolean;

  constructor(workingDirectory: string, verbose: boolean = false) {
    this.cwd = workingDirectory;
    this.contextPath = path.join(workingDirectory, ".8gent", "context");
    this.verbose = verbose;
    this.ensureDirectories();
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(`[8gent:memory] ${message}`);
    }
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.contextPath)) {
      fs.mkdirSync(this.contextPath, { recursive: true });
    }
  }

  getWorkingContext(): WorkingContext | null {
    const contextFile = path.join(this.contextPath, "working.json");
    try {
      if (fs.existsSync(contextFile)) {
        const context = JSON.parse(fs.readFileSync(contextFile, "utf-8"));
        // Check if expired (24h)
        const started = new Date(context.started);
        const now = new Date();
        const hoursDiff = (now.getTime() - started.getTime()) / (1000 * 60 * 60);
        if (hoursDiff < 24) {
          this.log("Restored working context");
          return context;
        }
      }
    } catch {}
    return null;
  }

  saveWorkingContext(context: WorkingContext): void {
    const contextFile = path.join(this.contextPath, "working.json");
    fs.writeFileSync(contextFile, JSON.stringify(context, null, 2));
    this.log("Saved working context");
  }

  logEvolution(entry: EvolutionEntry): void {
    const logFile = path.join(this.cwd, ".8gent", "evolution.log");
    const line = `[${entry.timestamp}] ${entry.action} ${entry.file}\n` +
      `  REASON: ${entry.reason}\n` +
      `  RESULT: ${entry.result}\n` +
      `  BRANCH: ${entry.branch}\n` +
      `  MERGED: ${entry.merged}\n\n`;

    fs.appendFileSync(logFile, line);
    this.log(`Evolution: ${entry.action} ${entry.file} → ${entry.result}`);
  }
}

// ============================================
// Self-Autonomy Engine
// ============================================

export class SelfAutonomy {
  private config: SelfAutonomyConfig;
  public git: AutoGit;
  public heal: SelfHeal;
  public memory: SessionMemory;
  private currentBranch: string | null = null;
  private currentTask: string | null = null;

  constructor(config: Partial<SelfAutonomyConfig> = {}) {
    this.config = {
      workingDirectory: config.workingDirectory || process.cwd(),
      autoGit: config.autoGit ?? true,
      selfHeal: config.selfHeal ?? true,
      selfModify: config.selfModify ?? true,
      verbose: config.verbose ?? true,
    };

    this.git = new AutoGit(this.config.workingDirectory, this.config.verbose);
    this.heal = new SelfHeal(this.config.workingDirectory, this.config.verbose);
    this.memory = new SessionMemory(this.config.workingDirectory, this.config.verbose);
  }

  /**
   * Start a new task with automatic branching
   */
  startTask(taskDescription: string, type: "feat" | "fix" | "refactor" = "feat"): void {
    if (!this.config.autoGit || !this.git.isGitRepo()) return;

    // Create slug from task
    const slug = taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);

    this.currentTask = taskDescription;
    this.currentBranch = this.git.createTaskBranch(slug, type);

    // Save to working context
    this.memory.saveWorkingContext({
      session: `sess_${Date.now()}`,
      started: new Date().toISOString(),
      project: path.basename(this.config.workingDirectory),
      branch: this.currentBranch,
      activeFiles: [],
      currentTask: taskDescription,
      blockers: [],
      notes: "",
    });
  }

  /**
   * Auto-commit changes during task
   */
  commitProgress(
    files: string[],
    type: "feat" | "fix" | "refactor" | "test" | "chore" | "docs",
    scope: string,
    message: string
  ): string | null {
    if (!this.config.autoGit || !this.git.isGitRepo()) return null;
    return this.git.commit(files, type, scope, message);
  }

  /**
   * Complete task and merge to main
   */
  completeTask(): boolean {
    if (!this.config.autoGit || !this.currentBranch) return false;

    const success = this.git.mergeBranch(this.currentBranch, false);

    if (success) {
      this.memory.logEvolution({
        timestamp: new Date().toISOString(),
        action: "MODIFY",
        file: `task: ${this.currentTask}`,
        reason: "Task completed",
        result: "SUCCESS",
        branch: this.currentBranch,
        merged: true,
      });
    }

    this.currentBranch = null;
    this.currentTask = null;
    return success;
  }

  /**
   * Handle an error with self-healing
   */
  async handleError(
    error: Error,
    operation: string,
    retryFn: () => Promise<any>,
    maxRetries: number = 3
  ): Promise<{ success: boolean; result?: any; solution?: string }> {
    if (!this.config.selfHeal) {
      throw error;
    }

    const errorPattern = this.normalizeError(error.message);
    const severity = this.heal.classifyError(error.message);

    // Fatal errors can't be auto-healed
    if (severity === "fatal") {
      return { success: false };
    }

    // Check for known solution
    const knownSolution = this.heal.getKnownSolution(errorPattern);
    if (knownSolution) {
      // Apply known solution logic here
      // This would need custom handlers per solution type
    }

    // Retry with backoff for transient errors
    if (severity === "transient") {
      for (let i = 0; i < maxRetries; i++) {
        const delay = Math.pow(2, i) * 1000;
        await new Promise((r) => setTimeout(r, delay));

        try {
          const result = await retryFn();
          this.heal.recordSuccess(errorPattern, "retry with backoff");
          return { success: true, result, solution: "retry" };
        } catch (retryError) {
          // Continue to next retry
        }
      }
    }

    // Try alternatives for recoverable errors
    if (severity === "recoverable") {
      const alternatives = this.heal.getAlternatives(operation);
      for (const alt of alternatives) {
        // Would need to implement alternative execution
        // For now, just log
        console.log(`[8gent:heal] Would try alternative: ${alt}`);
      }
    }

    return { success: false };
  }

  private normalizeError(message: string): string {
    // Normalize error message to pattern
    return message
      .toLowerCase()
      .replace(/[0-9]+/g, "N")
      .replace(/\/[^\s]+/g, "/PATH")
      .slice(0, 50);
  }

  /**
   * Prepare for self-modification
   */
  prepareForSelfModify(file: string, reason: string): string | null {
    if (!this.config.selfModify || !this.git.isGitRepo()) return null;

    // Create snapshot
    const snapshot = this.git.createSnapshot("pre-self-modify");

    // Create self-modification branch
    const slug = file.replace(/[^a-z0-9]+/gi, "-").slice(0, 20);
    const branch = this.git.createTaskBranch(slug, "self");

    this.memory.logEvolution({
      timestamp: new Date().toISOString(),
      action: "MODIFY",
      file,
      reason,
      result: "SUCCESS", // Will update if fails
      branch,
      merged: false,
    });

    return branch;
  }

  /**
   * Complete self-modification
   */
  completeSelfModify(success: boolean): void {
    if (!this.git.isGitRepo()) return;

    const state = this.git.getState();

    if (success) {
      this.git.mergeBranch(state.branch, false);
    } else {
      this.git.abortBranch();
    }
  }
}

// ============================================
// Exports
// ============================================

export function createSelfAutonomy(workingDirectory?: string): SelfAutonomy {
  return new SelfAutonomy({ workingDirectory });
}

// Re-export onboarding
export { OnboardingManager, type UserConfig, type OnboardingStep } from "./onboarding.js";

// Re-export evolution
export { reflect, type SessionData } from "./reflection.js";
export { learnSkill, getRelevantSkills, reinforceSkill, buildSkillsContext } from "./learned-skills.js";
export type { LearnedSkill, SessionReflection } from "./evolution-db.js";

export default {
  SelfAutonomy,
  AutoGit,
  SelfHeal,
  SessionMemory,
  createSelfAutonomy,
};
