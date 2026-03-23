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
  /** Infinite mode - bypass ALL permission checks (like --dangerously-skip-permissions) */
  infiniteMode?: boolean;
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

export interface InfiniteModeAuditEntry {
  timestamp: Date;
  command: string;
  action: string;
  details: string;
  blocked: boolean;
  reason?: string;
}

// ============================================
// Constants
// ============================================

/**
 * Maximum duration for infinite mode in milliseconds (30 minutes).
 */
const INFINITE_MODE_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * Commands that are NEVER allowed, even in infinite mode.
 * These are catastrophic system-level destructive operations.
 */
export const ALWAYS_BLOCKED_COMMANDS: Array<{
  command: string;
  args: string[];
  description: string;
}> = [
  { command: "rm", args: ["-rf", "/"], description: "recursive delete root filesystem" },
  { command: "rm", args: ["-rf", "/*"], description: "recursive delete all root contents" },
  { command: "rm", args: ["-rf", "--no-preserve-root", "/"], description: "force recursive delete root" },
  { command: "chmod", args: ["000", "/"], description: "remove all permissions from root" },
  { command: "chmod", args: ["-R", "000", "/"], description: "recursively remove all permissions from root" },
  { command: "chown", args: ["-R"], description: "recursive ownership change (check target)" },
  { command: "dd", args: ["of=/dev/sda"], description: "overwrite primary disk" },
  { command: "dd", args: ["of=/dev/nvme0n1"], description: "overwrite primary nvme" },
  { command: "mkfs", args: ["/dev/sda"], description: "format primary disk" },
  { command: ":(){ :|:& };:", args: [], description: "fork bomb" },
];

/**
 * Dangerous command definitions using token-based matching.
 * Each entry defines a command and optional argument patterns that make it dangerous.
 */
export const DANGEROUS_COMMAND_RULES: Array<{
  command: string;
  argPatterns?: string[][];
  description: string;
}> = [
  // Destructive file operations
  { command: "rm", argPatterns: [["-rf"], ["-r"], ["-f"]], description: "file deletion" },
  { command: "rmdir", description: "directory removal" },
  { command: "del", argPatterns: [["/s"]], description: "recursive delete (Windows)" },
  { command: "deltree", description: "tree deletion (Windows)" },

  // Privilege escalation
  { command: "sudo", description: "privilege escalation" },
  { command: "su", description: "switch user" },
  { command: "doas", description: "privilege escalation" },
  { command: "pkexec", description: "polkit privilege escalation" },

  // Permission changes
  { command: "chmod", description: "permission change" },
  { command: "chown", description: "ownership change" },
  { command: "chgrp", description: "group change" },
  { command: "icacls", description: "Windows ACL change" },
  { command: "cacls", description: "Windows ACL change" },

  // Disk operations
  { command: "dd", description: "disk copy" },
  { command: "mkfs", description: "filesystem creation" },
  { command: "fdisk", description: "disk partitioning" },
  { command: "parted", description: "disk partitioning" },
  { command: "diskutil", argPatterns: [["eraseDisk"], ["erasevolume"]], description: "disk utility" },
  { command: "format", description: "disk format (Windows)" },

  // System modification
  { command: "systemctl", description: "system service control" },
  { command: "service", description: "service control" },
  { command: "launchctl", description: "macOS service control" },
  { command: "reboot", description: "system reboot" },
  { command: "shutdown", description: "system shutdown" },
  { command: "init", description: "init level change" },

  // Network exposure
  { command: "iptables", description: "firewall rule change" },
  { command: "ufw", description: "firewall control" },
  { command: "firewall-cmd", description: "firewall control" },
  { command: "netsh", description: "Windows network config" },

  // Package removal
  { command: "apt", argPatterns: [["remove"], ["purge"]], description: "package removal" },
  { command: "yum", argPatterns: [["remove"]], description: "package removal" },
  { command: "dnf", argPatterns: [["remove"]], description: "package removal" },
  { command: "brew", argPatterns: [["uninstall"]], description: "package removal" },
  { command: "npm", argPatterns: [["uninstall", "-g"]], description: "global package removal" },

  // Dangerous git operations
  { command: "git", argPatterns: [["push", "--force"], ["reset", "--hard"], ["clean", "-fd"], ["clean", "-f"]], description: "destructive git operation" },

  // Environment manipulation
  { command: "export", argPatterns: [["PATH="]], description: "PATH modification" },
  { command: "setx", argPatterns: [["PATH"]], description: "persistent PATH modification" },
];

/**
 * Patterns in piped commands that indicate code execution risk.
 */
const DANGEROUS_PIPE_PATTERNS = ["| sh", "| bash", "| zsh", "|sh", "|bash", "|zsh"];
const DANGEROUS_PIPE_SOURCES = ["curl", "wget"];

/**
 * Commands that are considered safe for headless auto-approval.
 * Only read-only operations that cannot modify state.
 */
export const HEADLESS_SAFE_COMMANDS: string[] = [
  // Git read-only
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "git describe",
  "git ls-files",
  "git ls-tree",
  "git cat-file",

  // File reading
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "tree",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "date",
  "uname",
  "whoami",
  "pwd",
  "env",
  "printenv",

  // Build/test (read or idempotent)
  "tsc --noEmit",
  "bun run typecheck",
];

/**
 * Legacy list kept for backward compatibility in exports.
 */
export const DANGEROUS_COMMANDS = [
  "rm -rf", "rm -r", "rmdir", "del /s", "deltree",
  "sudo", "su ", "doas", "pkexec",
  "chmod", "chown", "chgrp", "icacls", "cacls",
  "dd ", "mkfs", "fdisk", "parted", "diskutil eraseDisk", "format ",
  "systemctl", "service ", "launchctl", "reboot", "shutdown", "init ",
  "iptables", "ufw ", "firewall-cmd", "netsh ",
  "apt remove", "apt purge", "yum remove", "dnf remove",
  "brew uninstall", "npm uninstall -g",
  "git push --force", "git reset --hard", "git clean -fd",
  "export PATH=", "setx PATH",
  "curl|", "curl |", "wget|", "wget |", "|sh", "|bash", "|zsh",
];

/**
 * Patterns that are generally safe and can be auto-approved.
 */
export const SAFE_PATTERNS = [
  // Package management (non-destructive)
  "npm install", "npm i ", "npm run", "npm test", "npm start", "npm build",
  "bun install", "bun run", "bun test",
  "yarn install", "yarn add", "yarn run",
  "pnpm install", "pnpm add", "pnpm run",

  // Git (non-destructive)
  "git status", "git log", "git diff", "git branch", "git checkout",
  "git add", "git commit", "git pull", "git fetch", "git stash", "git show",

  // Build tools
  "tsc", "esbuild", "vite", "webpack", "rollup", "turbo",

  // Testing
  "jest", "vitest", "mocha", "pytest", "cargo test", "go test",

  // Linting/formatting
  "eslint", "prettier", "biome", "rustfmt", "gofmt", "black",

  // Development servers
  "next dev", "vite dev", "npm run dev", "bun run dev",

  // File listing/reading (non-destructive)
  "ls", "dir", "cat", "head", "tail", "less", "more", "find", "grep", "tree", "wc",
];

// ============================================
// Command Parsing Utility
// ============================================

/**
 * Parse a command string into a command name and arguments.
 * Handles quoted strings and basic shell syntax.
 */
export function parseCommand(cmd: string): { command: string; args: string[] } {
  const trimmed = cmd.trim();
  if (!trimmed) return { command: "", args: [] };

  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\" && !inSingleQuote) {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if ((char === " " || char === "\t") && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) return { command: "", args: [] };

  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
}

// ============================================
// Permission Manager
// ============================================

export class PermissionManager {
  private config: PermissionConfig;
  private configPath: string;
  private log: PermissionLog;
  private approvedCommands: Set<string> = new Set();
  private deniedCommands: Set<string> = new Set();
  private infiniteMode: boolean = false;
  private infiniteModeStartTime: number | null = null;
  private infiniteModeAuditLog: InfiniteModeAuditEntry[] = [];

  constructor(configPath?: string) {
    const dataDir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
    this.configPath = configPath || path.join(dataDir, "permissions.json");
    this.config = this.loadConfig();
    this.log = {
      requests: [],
      deniedCount: 0,
      approvedCount: 0,
      autoApprovedCount: 0,
    };
  }

  /**
   * Enable infinite mode - bypasses most permission checks.
   * Expires after 30 minutes. Catastrophic commands are still blocked.
   */
  enableInfiniteMode(): void {
    this.infiniteMode = true;
    this.infiniteModeStartTime = Date.now();
    this.infiniteModeAuditLog = [];
    console.log(
      `\x1b[33m[INF] Infinite Loop mode enabled (expires in 30 minutes)\x1b[0m`
    );
  }

  /**
   * Disable infinite mode - normal permission checks resume.
   */
  disableInfiniteMode(): void {
    this.infiniteMode = false;
    this.infiniteModeStartTime = null;
    console.log(`\x1b[33m[INF] Infinite Loop mode disabled\x1b[0m`);
  }

  /**
   * Check if infinite mode is active (accounts for expiry).
   */
  isInfiniteMode(): boolean {
    if (!this.infiniteMode) return false;

    // Check time limit
    if (this.infiniteModeStartTime !== null) {
      const elapsed = Date.now() - this.infiniteModeStartTime;
      if (elapsed >= INFINITE_MODE_MAX_DURATION_MS) {
        console.log(
          `\x1b[33m[INF] Infinite Loop mode expired after 30 minutes\x1b[0m`
        );
        this.infiniteMode = false;
        this.infiniteModeStartTime = null;
        return false;
      }
    }

    return true;
  }

  /**
   * Get the audit log of all actions taken during infinite mode.
   */
  getInfiniteModeAuditLog(): InfiniteModeAuditEntry[] {
    return [...this.infiniteModeAuditLog];
  }

  /**
   * Get remaining time in infinite mode (in ms), or 0 if not active.
   */
  getInfiniteModeRemainingMs(): number {
    if (!this.infiniteMode || this.infiniteModeStartTime === null) return 0;
    const elapsed = Date.now() - this.infiniteModeStartTime;
    return Math.max(0, INFINITE_MODE_MAX_DURATION_MS - elapsed);
  }

  /**
   * Check if a command is catastrophic and should ALWAYS be blocked,
   * even in infinite mode.
   */
  private isAlwaysBlocked(command: string): { blocked: boolean; reason?: string } {
    const parsed = parseCommand(command);
    const cmd = parsed.command.toLowerCase();
    const argsLower = parsed.args.map((a) => a.toLowerCase());

    for (const rule of ALWAYS_BLOCKED_COMMANDS) {
      if (cmd !== rule.command && !cmd.endsWith("/" + rule.command)) continue;

      // If rule has no args, just matching the command is enough
      if (rule.args.length === 0) {
        return { blocked: true, reason: rule.description };
      }

      // Check if all rule args appear in the command args
      const allArgsPresent = rule.args.every((ruleArg) =>
        argsLower.some((a) => a === ruleArg.toLowerCase() || a.startsWith(ruleArg.toLowerCase()))
      );

      if (allArgsPresent) {
        return { blocked: true, reason: rule.description };
      }
    }

    // Also block fork bombs by content
    if (command.includes(":(){ :|:& };:")) {
      return { blocked: true, reason: "fork bomb" };
    }

    return { blocked: false };
  }

  /**
   * Log an action during infinite mode.
   */
  private auditInfiniteMode(
    command: string,
    action: string,
    details: string,
    blocked: boolean,
    reason?: string
  ): void {
    const entry: InfiniteModeAuditEntry = {
      timestamp: new Date(),
      command,
      action,
      details,
      blocked,
      reason,
    };
    this.infiniteModeAuditLog.push(entry);

    // Also write to log file if configured
    if (this.config.logPath) {
      const logLine =
        JSON.stringify({
          ...entry,
          timestamp: entry.timestamp.toISOString(),
          mode: "infinite",
        }) + "\n";

      try {
        fs.appendFileSync(this.config.logPath, logLine);
      } catch (err) {
        // Silent - don't break the flow for audit logging
      }
    }
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
   * Check if a command matches any dangerous patterns.
   * Uses token-based parsing instead of substring matching.
   */
  isDangerous(command: string): boolean {
    const normalizedCmd = command.trim();
    const parsed = parseCommand(normalizedCmd);
    const cmdLower = parsed.command.toLowerCase();
    const argsLower = parsed.args.map((a) => a.toLowerCase());
    const fullCmdLower = normalizedCmd.toLowerCase();

    // Check for dangerous pipe patterns (curl/wget piped to shell)
    for (const source of DANGEROUS_PIPE_SOURCES) {
      if (cmdLower === source) {
        for (const pipePattern of DANGEROUS_PIPE_PATTERNS) {
          if (fullCmdLower.includes(pipePattern)) {
            return true;
          }
        }
      }
    }

    // Also check if a pipe to shell exists anywhere in the command
    for (const pipePattern of DANGEROUS_PIPE_PATTERNS) {
      if (fullCmdLower.includes(pipePattern)) {
        // Only flag if the pipe target is a shell
        return true;
      }
    }

    // Token-based matching against dangerous command rules
    for (const rule of DANGEROUS_COMMAND_RULES) {
      // Check if the command (first token) matches the rule
      if (cmdLower !== rule.command && !cmdLower.endsWith("/" + rule.command)) {
        continue;
      }

      // If no specific arg patterns, the command itself is dangerous
      if (!rule.argPatterns || rule.argPatterns.length === 0) {
        return true;
      }

      // Check if any arg pattern matches
      for (const argPattern of rule.argPatterns) {
        const allArgsMatch = argPattern.every((requiredArg) => {
          const reqLower = requiredArg.toLowerCase();
          return argsLower.some(
            (a) => a === reqLower || a.startsWith(reqLower)
          );
        });

        if (allArgsMatch) {
          return true;
        }
      }
    }

    // Check against user-defined denied patterns
    for (const pattern of this.config.deniedPatterns) {
      if (this.matchPattern(fullCmdLower, pattern)) {
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
   * Check if a command is safe for headless auto-approval.
   * Uses the first token of the command for matching.
   */
  private isHeadlessSafe(command: string): boolean {
    const parsed = parseCommand(command);
    const cmdLower = parsed.command.toLowerCase();
    const fullCmdLower = command.toLowerCase().trim();

    for (const safe of HEADLESS_SAFE_COMMANDS) {
      const safeParts = safe.split(" ");
      const safeCmd = safeParts[0].toLowerCase();

      if (cmdLower === safeCmd) {
        // If the safe entry has specific subcommands, check them
        if (safeParts.length > 1) {
          const safeSubCmd = safeParts.slice(1).join(" ").toLowerCase();
          if (fullCmdLower.startsWith(safe.toLowerCase())) {
            return true;
          }
        } else {
          // Just the command name matches, no subcommand required
          return true;
        }
      }
    }

    return false;
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

    // INFINITE MODE: Bypass most permission checks, but block catastrophic commands
    if (this.isInfiniteMode()) {
      if (command) {
        const blockCheck = this.isAlwaysBlocked(command);
        if (blockCheck.blocked) {
          this.auditInfiniteMode(
            command,
            action,
            details,
            true,
            `BLOCKED even in infinite mode: ${blockCheck.reason}`
          );
          request.approved = false;
          this.log.requests.push(request);
          this.log.deniedCount++;
          console.log(
            `\x1b[31m[INF] BLOCKED: ${command} - ${blockCheck.reason}\x1b[0m`
          );
          return false;
        }
      }

      // Audit and approve
      this.auditInfiniteMode(command || "", action, details, false);
      request.approved = true;
      request.autoApproved = true;
      this.log.requests.push(request);
      this.log.autoApprovedCount++;
      return true;
    }

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
    // In daemon/headless mode (no TTY), only auto-approve read-only operations
    if (!process.stdin.isTTY) {
      const cmd = (command || "").toLowerCase().trim();

      // Always block push/merge to main/master
      const isMainPush = cmd.includes("push") && (cmd.includes("main") || cmd.includes("master"));
      const isMerge = cmd.includes("merge") && (cmd.includes("main") || cmd.includes("master"));
      if (isMainPush || isMerge) {
        console.log(`[permissions] BLOCKED (headless): merge/push to main requires Telegram approval - ${command}`);
        return false;
      }

      // Only auto-approve commands on the headless safe list
      if (command && this.isHeadlessSafe(command)) {
        console.log(`[permissions] auto-approved (headless/read-only): ${action} - ${command || details}`);
        return true;
      }

      // Everything else requires explicit approval in headless mode
      console.log(`[permissions] BLOCKED (headless): ${action} requires explicit approval - ${command || details}`);
      return false;
    }

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
    // INFINITE MODE: Allow everything except always-blocked commands
    if (this.isInfiniteMode()) {
      if (command) {
        const blockCheck = this.isAlwaysBlocked(command);
        if (blockCheck.blocked) {
          return "denied";
        }
      }
      return "allowed";
    }

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

/**
 * Enable infinite mode - bypasses most permission checks (30 min limit).
 * Catastrophic commands are still blocked.
 */
export function enableInfiniteMode(): void {
  const manager = getPermissionManager();
  manager.enableInfiniteMode();
}

/**
 * Disable infinite mode
 */
export function disableInfiniteMode(): void {
  const manager = getPermissionManager();
  manager.disableInfiniteMode();
}

/**
 * Check if infinite mode is active
 */
export function isInfiniteMode(): boolean {
  const manager = getPermissionManager();
  return manager.isInfiniteMode();
}
