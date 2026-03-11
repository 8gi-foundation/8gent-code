/**
 * 8gent Code - Permission System
 *
 * Security layer that controls what commands and actions the agent can execute.
 * Inspired by Claude Code's permission system with dangerous command detection.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

// ============================================
// Types
// ============================================

export interface PermissionConfig {
  allowedPatterns: string[];
  deniedPatterns: string[];
  autoApprove: boolean;
  logPath?: string;
}

export interface PermissionRequest {
  id: string;
  action: string;
  details: string;
  command?: string;
  timestamp: Date;
  approved?: boolean;
  autoApproved?: boolean;
}

export interface PermissionLog {
  requests: PermissionRequest[];
  deniedCount: number;
  approvedCount: number;
  autoApprovedCount: number;
}

// ============================================
// Constants
// ============================================

/**
 * Commands that are considered dangerous and require explicit user approval.
 * These can cause data loss, system damage, or security issues.
 */
export const DANGEROUS_COMMANDS = [
  // Destructive file operations
  "rm -rf",
  "rm -r",
  "rmdir",
  "del /s",
  "deltree",

  // Privilege escalation
  "sudo",
  "su ",
  "doas",
  "pkexec",

  // Permission changes
  "chmod",
  "chown",
  "chgrp",
  "icacls",
  "cacls",

  // Disk operations
  "dd ",
  "mkfs",
  "fdisk",
  "parted",
  "diskutil eraseDisk",
  "format ",

  // System modification
  "systemctl",
  "service ",
  "launchctl",
  "reboot",
  "shutdown",
  "init ",

  // Network exposure
  "iptables",
  "ufw ",
  "firewall-cmd",
  "netsh ",

  // Package managers with system access
  "apt remove",
  "apt purge",
  "yum remove",
  "dnf remove",
  "brew uninstall",
  "npm uninstall -g",

  // Dangerous git operations
  "git push --force",
  "git reset --hard",
  "git clean -fd",

  // Environment manipulation
  "export PATH=",
  "setx PATH",

  // Curl/wget to pipes (code execution risk)
  "curl|",
  "curl |",
  "wget|",
  "wget |",
  "|sh",
  "|bash",
  "|zsh",
];

/**
 * Patterns that are generally safe and can be auto-approved.
 */
export const SAFE_PATTERNS = [
  // Package management (non-destructive)
  "npm install",
  "npm i ",
  "npm run",
  "npm test",
  "npm start",
  "npm build",
  "bun install",
  "bun run",
  "bun test",
  "yarn install",
  "yarn add",
  "yarn run",
  "pnpm install",
  "pnpm add",
  "pnpm run",

  // Git (non-destructive)
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git checkout",
  "git add",
  "git commit",
  "git pull",
  "git fetch",
  "git stash",
  "git show",

  // Build tools
  "tsc",
  "esbuild",
  "vite",
  "webpack",
  "rollup",
  "turbo",

  // Testing
  "jest",
  "vitest",
  "mocha",
  "pytest",
  "cargo test",
  "go test",

  // Linting/formatting
  "eslint",
  "prettier",
  "biome",
  "rustfmt",
  "gofmt",
  "black",

  // Development servers
  "next dev",
  "vite dev",
  "npm run dev",
  "bun run dev",

  // File listing/reading (non-destructive)
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "find",
  "grep",
  "tree",
  "wc",
];

// ============================================
// Permission Manager
// ============================================

export class PermissionManager {
  private config: PermissionConfig;
  private configPath: string;
  private log: PermissionLog;
  private approvedCommands: Set<string> = new Set();
  private deniedCommands: Set<string> = new Set();

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(os.homedir(), ".8gent", "permissions.json");
    this.config = this.loadConfig();
    this.log = {
      requests: [],
      deniedCount: 0,
      approvedCount: 0,
      autoApprovedCount: 0,
    };
  }

  /**
   * Load configuration from disk
   */
  private loadConfig(): PermissionConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, "utf-8");
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn(`Warning: Could not load permissions config: ${err}`);
    }

    // Default config
    return {
      allowedPatterns: ["npm *", "bun *", "git *", "ls *", "cat *"],
      deniedPatterns: ["rm -rf /", "sudo rm -rf", ":(){ :|:& };:"],
      autoApprove: false,
    };
  }

  /**
   * Save configuration to disk
   */
  saveConfig(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Check if a command matches any dangerous patterns
   */
  isDangerous(command: string): boolean {
    const normalizedCmd = command.toLowerCase().trim();

    // Check against dangerous commands list
    for (const dangerous of DANGEROUS_COMMANDS) {
      if (normalizedCmd.includes(dangerous.toLowerCase())) {
        return true;
      }
    }

    // Check against user-defined denied patterns
    for (const pattern of this.config.deniedPatterns) {
      if (this.matchPattern(normalizedCmd, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a command is pre-approved (safe or user-allowed)
   */
  isAllowed(command: string): boolean {
    const normalizedCmd = command.toLowerCase().trim();

    // Check if explicitly denied
    if (this.deniedCommands.has(normalizedCmd)) {
      return false;
    }

    // Check if explicitly approved in session
    if (this.approvedCommands.has(normalizedCmd)) {
      return true;
    }

    // Check user-defined allowed patterns
    for (const pattern of this.config.allowedPatterns) {
      if (this.matchPattern(normalizedCmd, pattern)) {
        return true;
      }
    }

    // Check safe patterns (auto-approve)
    for (const safe of SAFE_PATTERNS) {
      if (normalizedCmd.startsWith(safe.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Match a command against a glob-like pattern
   */
  private matchPattern(command: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special chars except * and ?
      .replace(/\*/g, ".*")                  // * matches anything
      .replace(/\?/g, ".");                  // ? matches single char

    const regex = new RegExp(`^${regexPattern}$`, "i");
    return regex.test(command);
  }

  /**
   * Request permission from the user for a command/action
   */
  async requestPermission(action: string, details: string, command?: string): Promise<boolean> {
    const request: PermissionRequest = {
      id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action,
      details,
      command,
      timestamp: new Date(),
    };

    // Auto-approve if configured and not dangerous
    if (this.config.autoApprove && command && !this.isDangerous(command)) {
      request.approved = true;
      request.autoApproved = true;
      this.log.requests.push(request);
      this.log.autoApprovedCount++;
      return true;
    }

    // Check if already approved or safe
    if (command && this.isAllowed(command) && !this.isDangerous(command)) {
      request.approved = true;
      request.autoApproved = true;
      this.log.requests.push(request);
      this.log.autoApprovedCount++;
      return true;
    }

    // Interactive prompt
    const approved = await this.promptUser(action, details, command);
    request.approved = approved;
    this.log.requests.push(request);

    if (approved) {
      this.log.approvedCount++;
      if (command) {
        this.approvedCommands.add(command.toLowerCase().trim());
      }
    } else {
      this.log.deniedCount++;
      if (command) {
        this.deniedCommands.add(command.toLowerCase().trim());
      }
    }

    return approved;
  }

  /**
   * Prompt user for permission (Y/n)
   */
  private async promptUser(action: string, details: string, command?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // Build prompt message
      let prompt = `\n\x1b[33m[PERMISSION REQUIRED]\x1b[0m\n`;
      prompt += `Action: ${action}\n`;
      prompt += `Details: ${details}\n`;
      if (command) {
        prompt += `Command: \x1b[36m${command}\x1b[0m\n`;
        if (this.isDangerous(command)) {
          prompt += `\x1b[31m[DANGEROUS]\x1b[0m This command may cause data loss or system changes.\n`;
        }
      }
      prompt += `\nAllow? [Y/n]: `;

      rl.question(prompt, (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        // Default to Yes if empty, explicit no required
        resolve(normalized !== "n" && normalized !== "no");
      });
    });
  }

  /**
   * Check permission for a command without prompting
   * Returns: "allowed" | "denied" | "ask"
   */
  checkPermission(command: string): "allowed" | "denied" | "ask" {
    const normalizedCmd = command.toLowerCase().trim();

    // Check explicit deny list
    if (this.deniedCommands.has(normalizedCmd)) {
      return "denied";
    }

    // Check if explicitly denied by pattern
    for (const pattern of this.config.deniedPatterns) {
      if (this.matchPattern(normalizedCmd, pattern)) {
        return "denied";
      }
    }

    // Check if dangerous (always ask)
    if (this.isDangerous(command)) {
      return "ask";
    }

    // Check if allowed
    if (this.isAllowed(command)) {
      return "allowed";
    }

    // Unknown command - ask
    return "ask";
  }

  /**
   * Add a pattern to the allowed list
   */
  allowPattern(pattern: string): void {
    if (!this.config.allowedPatterns.includes(pattern)) {
      this.config.allowedPatterns.push(pattern);
      this.saveConfig();
    }
  }

  /**
   * Add a pattern to the denied list
   */
  denyPattern(pattern: string): void {
    if (!this.config.deniedPatterns.includes(pattern)) {
      this.config.deniedPatterns.push(pattern);
      this.saveConfig();
    }
  }

  /**
   * Remove a pattern from the allowed list
   */
  removeAllowedPattern(pattern: string): void {
    this.config.allowedPatterns = this.config.allowedPatterns.filter(p => p !== pattern);
    this.saveConfig();
  }

  /**
   * Remove a pattern from the denied list
   */
  removeDeniedPattern(pattern: string): void {
    this.config.deniedPatterns = this.config.deniedPatterns.filter(p => p !== pattern);
    this.saveConfig();
  }

  /**
   * Set auto-approve mode
   */
  setAutoApprove(enabled: boolean): void {
    this.config.autoApprove = enabled;
    this.saveConfig();
  }

  /**
   * Get current configuration
   */
  getConfig(): PermissionConfig {
    return { ...this.config };
  }

  /**
   * Get permission log
   */
  getLog(): PermissionLog {
    return { ...this.log };
  }

  /**
   * Clear session approvals/denials (keeps config patterns)
   */
  clearSession(): void {
    this.approvedCommands.clear();
    this.deniedCommands.clear();
    this.log = {
      requests: [],
      deniedCount: 0,
      approvedCount: 0,
      autoApprovedCount: 0,
    };
  }

  /**
   * Log a permission request (for audit trail)
   */
  logRequest(request: PermissionRequest): void {
    this.log.requests.push(request);

    // Optionally write to log file
    if (this.config.logPath) {
      const logLine = JSON.stringify({
        ...request,
        timestamp: request.timestamp.toISOString(),
      }) + "\n";

      try {
        fs.appendFileSync(this.config.logPath, logLine);
      } catch (err) {
        console.warn(`Warning: Could not write to permission log: ${err}`);
      }
    }
  }
}

// ============================================
// Singleton Instance
// ============================================

let permissionManagerInstance: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!permissionManagerInstance) {
    permissionManagerInstance = new PermissionManager();
  }
  return permissionManagerInstance;
}

export function resetPermissionManager(): void {
  permissionManagerInstance?.clearSession();
  permissionManagerInstance = null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Quick check if a command needs permission
 */
export function needsPermission(command: string): boolean {
  const manager = getPermissionManager();
  return manager.checkPermission(command) !== "allowed";
}

/**
 * Request permission for a command (convenience function)
 */
export async function requestCommandPermission(command: string): Promise<boolean> {
  const manager = getPermissionManager();
  const check = manager.checkPermission(command);

  if (check === "allowed") return true;
  if (check === "denied") return false;

  return manager.requestPermission(
    "Execute Command",
    `The agent wants to run a shell command.`,
    command
  );
}

/**
 * Check if command is dangerous (convenience function)
 */
export function isCommandDangerous(command: string): boolean {
  const manager = getPermissionManager();
  return manager.isDangerous(command);
}
