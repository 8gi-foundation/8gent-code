/**
 * 8gent Code - Default Hooks
 *
 * Pre-configured hooks for common workflows.
 * Users can import and register these, or use them as templates.
 */

import type { Hook, HookContext } from "./index";
import { registerShellHook, registerFunctionHook, getHookManager } from "./index";

// ============================================
// Logging Hooks
// ============================================

/**
 * Log all tool executions to a file
 */
export const loggingHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Tool Logger",
  description: "Logs all tool executions to ~/.8gent/logs/tools.log",
  mode: "shell",
  command: 'echo "[$(date -Iseconds)] Tool: {tool}" >> ~/.8gent/logs/tools.log',
  enabled: false,
  continueOnError: true,
  async: true,
};

/**
 * Log all commands to a file
 */
export const commandLoggingHook: Omit<Hook, "id"> = {
  type: "afterCommand",
  name: "Command Logger",
  description: "Logs all shell commands to ~/.8gent/logs/commands.log",
  mode: "shell",
  command: 'echo "[$(date -Iseconds)] Command: {command} (exit: {exitCode})" >> ~/.8gent/logs/commands.log',
  enabled: false,
  continueOnError: true,
  async: true,
};

/**
 * Log errors to a separate file
 */
export const errorLoggingHook: Omit<Hook, "id"> = {
  type: "onError",
  name: "Error Logger",
  description: "Logs all errors to ~/.8gent/logs/errors.log",
  mode: "shell",
  command: 'echo "[$(date -Iseconds)] Error: {error}" >> ~/.8gent/logs/errors.log',
  enabled: false,
  continueOnError: true,
};

// ============================================
// Timing Hooks
// ============================================

/**
 * Track execution timing for tools
 */
export const timingHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Execution Timer",
  description: "Tracks tool execution time",
  mode: "function",
  functionBody: `
    const duration = context.duration || 0;
    const tool = context.tool || 'unknown';
    console.log(\`[TIMING] \${tool}: \${duration}ms\`);
    return { tool, duration };
  `,
  enabled: false,
  continueOnError: true,
};

// ============================================
// Notification Hooks
// ============================================

/**
 * macOS notification on task completion
 */
export const macosNotificationHook: Omit<Hook, "id"> = {
  type: "onComplete",
  name: "macOS Notification",
  description: "Shows a macOS notification when task completes",
  mode: "shell",
  command: 'osascript -e \'display notification "Task completed" with title "8gent Code"\'',
  enabled: false,
  continueOnError: true,
  async: true,
};

/**
 * macOS text-to-speech on completion (like AI James)
 */
export const macosVoiceHook: Omit<Hook, "id"> = {
  type: "onComplete",
  name: "Voice Notification",
  description: "Speaks completion message using macOS TTS",
  mode: "shell",
  command: 'say -v Ava "Task completed"',
  enabled: false,
  continueOnError: true,
  async: true,
};

/**
 * Terminal bell on completion
 */
export const terminalBellHook: Omit<Hook, "id"> = {
  type: "onComplete",
  name: "Terminal Bell",
  description: "Plays terminal bell sound when task completes",
  mode: "shell",
  command: 'printf "\\a"',
  enabled: false,
  continueOnError: true,
};

/**
 * Telegram notification (requires bot token setup)
 */
export const telegramNotificationHook: Omit<Hook, "id"> = {
  type: "onComplete",
  name: "Telegram Notification",
  description: "Sends Telegram message on completion (requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars)",
  mode: "shell",
  command: 'curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d "chat_id=$TELEGRAM_CHAT_ID&text=8gent: Task completed"',
  enabled: false,
  continueOnError: true,
  async: true,
};

// ============================================
// Git Hooks
// ============================================

/**
 * Auto-stage changes after file writes
 */
export const autoGitAddHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Auto Git Add",
  description: "Automatically stages file changes after write_file tool",
  mode: "function",
  functionBody: `
    if (context.tool === 'write_file') {
      const path = context.toolInput?.path;
      if (path) {
        require('child_process').execSync(\`git add "\${path}"\`, { cwd: context.workingDirectory });
        return \`Staged: \${path}\`;
      }
    }
    return null;
  `,
  enabled: false,
  continueOnError: true,
};

/**
 * Show git status after file operations
 */
export const gitStatusAfterWriteHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Git Status After Write",
  description: "Shows git status after file operations",
  mode: "shell",
  command: '[ "{tool}" = "write_file" ] && git status --short || true',
  enabled: false,
  continueOnError: true,
};

// ============================================
// Safety Hooks
// ============================================

/**
 * Backup files before editing
 */
export const backupBeforeEditHook: Omit<Hook, "id"> = {
  type: "beforeTool",
  name: "Backup Before Edit",
  description: "Creates backup of files before editing",
  mode: "function",
  functionBody: `
    if (context.tool === 'edit_file' || context.tool === 'write_file') {
      const path = context.toolInput?.path;
      if (path) {
        const fs = require('fs');
        const backupPath = path + '.8gent-backup';
        if (fs.existsSync(path)) {
          fs.copyFileSync(path, backupPath);
          return \`Backed up: \${path}\`;
        }
      }
    }
    return null;
  `,
  enabled: false,
  continueOnError: true,
};

/**
 * Validate commands before execution
 */
export const commandValidationHook: Omit<Hook, "id"> = {
  type: "beforeCommand",
  name: "Command Validator",
  description: "Logs dangerous commands before execution",
  mode: "function",
  functionBody: `
    const dangerous = ['rm -rf', 'sudo', 'chmod', 'dd ', 'mkfs'];
    const cmd = context.command?.toLowerCase() || '';
    for (const d of dangerous) {
      if (cmd.includes(d)) {
        console.warn(\`[WARNING] Dangerous command detected: \${context.command}\`);
        return 'DANGEROUS';
      }
    }
    return 'OK';
  `,
  enabled: false,
  continueOnError: true,
};

// ============================================
// Session Hooks
// ============================================

/**
 * Welcome message on session start
 */
export const sessionStartHook: Omit<Hook, "id"> = {
  type: "onStart",
  name: "Session Start",
  description: "Shows welcome message when session starts",
  mode: "shell",
  command: 'echo "Session started: {sessionId}"',
  enabled: false,
  continueOnError: true,
};

/**
 * Summary on session exit
 */
export const sessionExitHook: Omit<Hook, "id"> = {
  type: "onExit",
  name: "Session Exit",
  description: "Shows summary when session ends",
  mode: "shell",
  command: 'echo "Session ended: {sessionId}"',
  enabled: false,
  continueOnError: true,
};

// ============================================
// Development Hooks
// ============================================

/**
 * Run linter after file changes
 */
export const autoLintHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Auto Lint",
  description: "Runs linter after file writes",
  mode: "function",
  functionBody: `
    if (context.tool === 'write_file') {
      const path = context.toolInput?.path || '';
      const ext = path.split('.').pop()?.toLowerCase();
      if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        try {
          require('child_process').execSync(\`bunx biome check "\${path}" --apply\`, {
            cwd: context.workingDirectory,
            stdio: 'ignore'
          });
          return \`Linted: \${path}\`;
        } catch {
          return \`Lint errors in: \${path}\`;
        }
      }
    }
    return null;
  `,
  enabled: false,
  continueOnError: true,
};

/**
 * Format files after writing
 */
export const autoFormatHook: Omit<Hook, "id"> = {
  type: "afterTool",
  name: "Auto Format",
  description: "Formats files after writing using Prettier/Biome",
  mode: "shell",
  command: '[ "{tool}" = "write_file" ] && bunx prettier --write "$(dirname {workingDirectory})/$(basename {toolInput.path})" 2>/dev/null || true',
  enabled: false,
  continueOnError: true,
  async: true,
};

// ============================================
// Registration Helper
// ============================================

/**
 * All default hooks in one array
 */
export const DEFAULT_HOOKS: Omit<Hook, "id">[] = [
  // Logging
  loggingHook,
  commandLoggingHook,
  errorLoggingHook,

  // Timing
  timingHook,

  // Notifications
  macosNotificationHook,
  macosVoiceHook,
  terminalBellHook,
  telegramNotificationHook,

  // Git
  autoGitAddHook,
  gitStatusAfterWriteHook,

  // Safety
  backupBeforeEditHook,
  commandValidationHook,

  // Session
  sessionStartHook,
  sessionExitHook,

  // Development
  autoLintHook,
  autoFormatHook,
];

/**
 * Register all default hooks (disabled by default)
 */
export function registerDefaultHooks(): void {
  const manager = getHookManager();

  for (const hook of DEFAULT_HOOKS) {
    // Check if hook with same name already exists
    const existing = manager.getAllHooks().find(h => h.name === hook.name);
    if (!existing) {
      manager.registerHook(hook);
    }
  }
}

/**
 * Register and enable specific default hooks by name
 */
export function enableDefaultHooks(hookNames: string[]): void {
  const manager = getHookManager();

  for (const name of hookNames) {
    const hookDef = DEFAULT_HOOKS.find(h => h.name === name);
    if (hookDef) {
      const hook = manager.registerHook({ ...hookDef, enabled: true });
      console.log(`Enabled hook: ${hook.name}`);
    }
  }
}

/**
 * Quick setup for common scenarios
 */
export function setupLoggingHooks(): void {
  enableDefaultHooks(["Tool Logger", "Command Logger", "Error Logger"]);
}

export function setupNotificationHooks(): void {
  enableDefaultHooks(["macOS Notification", "Terminal Bell"]);
}

export function setupGitHooks(): void {
  enableDefaultHooks(["Auto Git Add", "Git Status After Write"]);
}

export function setupSafetyHooks(): void {
  enableDefaultHooks(["Backup Before Edit", "Command Validator"]);
}

export function setupDeveloperHooks(): void {
  enableDefaultHooks(["Auto Lint", "Auto Format", "Execution Timer"]);
}
