/**
 * 8gent Code - Hooks System
 *
 * Extensible lifecycle hooks that allow users to inject custom behavior
 * at key points in the agent workflow. Inspired by git hooks and Claude Code hooks.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, exec } from "child_process";
import { parse as parseYaml } from "yaml";

// ============================================
// Types
// ============================================

export type HookType =
  | "beforeTool"     // Before any tool execution
  | "afterTool"      // After any tool execution
  | "onError"        // When a tool or agent errors
  | "onComplete"     // When a full task/conversation completes
  | "beforeCommand"  // Before shell command execution
  | "afterCommand"   // After shell command execution
  | "onStart"        // When agent session starts
  | "onExit";        // When agent session ends

export interface HookContext {
  // General context
  sessionId: string;
  timestamp: Date;
  workingDirectory: string;

  // Tool-specific (for beforeTool, afterTool)
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;

  // Command-specific (for beforeCommand, afterCommand)
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;

  // Error context (for onError)
  error?: string;
  errorStack?: string;

  // Result context (for onComplete)
  result?: string;
  tokenCount?: number;
  duration?: number;
}

export interface Hook {
  id: string;
  type: HookType;
  name: string;
  description?: string;
  enabled: boolean;

  // Execution mode
  mode: "shell" | "function" | "script";

  // For shell mode: command to execute
  command?: string;

  // For script mode: path to script file
  scriptPath?: string;

  // For function mode: inline JS function (serialized)
  functionBody?: string;

  // Execution options
  timeout?: number;      // Max execution time in ms
  async?: boolean;       // Run async (don't wait for result)
  continueOnError?: boolean;  // Continue if hook fails
}

export interface HooksConfig {
  hooks: Hook[];
  globalTimeout: number;
  logPath?: string;
  enabled: boolean;
}

export interface HookResult {
  hookId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}

// ============================================
// YAML Hook Types (user-customizable lifecycle hooks)
// ============================================

export type YamlHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "OnError";

/** Maps YAML event names to internal HookType names */
const YAML_EVENT_MAP: Record<YamlHookEvent, HookType> = {
  PreToolUse: "beforeTool",
  PostToolUse: "afterTool",
  SessionStart: "onStart",
  SessionEnd: "onExit",
  OnError: "onError",
};

export interface YamlHookConfig {
  event: YamlHookEvent;
  matcher?: string;    // tool name glob: exact name or "*"
  command: string;     // shell command to run
  timeout?: number;    // ms, default 5000
}

export interface YamlHookFireResult {
  blocked: boolean;
  reason?: string;
  hookResults: Array<{
    command: string;
    success: boolean;
    output?: unknown;
    error?: string;
    durationMs: number;
  }>;
}

const YAML_HOOKS_PATH = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "hooks.yaml"
);

const DEFAULT_YAML_TIMEOUT = 5000;

/**
 * Check if a tool name matches a glob pattern.
 * Supports exact match and "*" wildcard (matches everything).
 */
function matchesToolName(pattern: string | undefined, toolName: string | undefined): boolean {
  if (!pattern || pattern === "*") return true;
  if (!toolName) return true; // non-tool events always match
  return pattern === toolName;
}

/**
 * Run a YAML hook command, sending payload via stdin and reading JSON from stdout.
 * Returns parsed JSON output or null on failure.
 */
function runYamlHookCommand(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  cwd: string,
): Promise<{ output: unknown; success: boolean; error?: string; durationMs: number }> {
  const start = Date.now();

  return new Promise((resolve) => {
    try {
      const proc = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({
          output: null,
          success: false,
          error: `Hook timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (code !== 0) {
          resolve({ output: null, success: false, error: `Exit code ${code}: ${stderr}`, durationMs });
          return;
        }

        // Try parsing stdout as JSON
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve({ output: null, success: true, durationMs });
          return;
        }

        try {
          resolve({ output: JSON.parse(trimmed), success: true, durationMs });
        } catch {
          resolve({ output: trimmed, success: true, durationMs });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ output: null, success: false, error: String(err), durationMs: Date.now() - start });
      });

      // Send payload as JSON to stdin
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (err) {
      resolve({ output: null, success: false, error: String(err), durationMs: Date.now() - start });
    }
  });
}

// ============================================
// Hook Manager
// ============================================

export class HookManager {
  private config: HooksConfig;
  private configPath: string;
  private sessionId: string;
  private workingDirectory: string;
  private results: HookResult[] = [];

  private yamlHooks: YamlHookConfig[] = [];

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(os.homedir(), ".8gent", "hooks.json");
    this.config = this.loadConfig();
    this.yamlHooks = this.loadYamlHooks();
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.workingDirectory = process.cwd();
  }

  /**
   * Load hooks configuration from disk
   */
  private loadConfig(): HooksConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, "utf-8");
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn(`Warning: Could not load hooks config: ${err}`);
    }

    // Default config with example hooks
    return {
      hooks: [],
      globalTimeout: 30000, // 30 seconds
      enabled: true,
    };
  }

  /**
   * Load YAML hook configs from ~/.8gent/hooks.yaml
   */
  private loadYamlHooks(): YamlHookConfig[] {
    const yamlPath = process.env.EIGHT_HOOKS_YAML || YAML_HOOKS_PATH;
    try {
      if (!fs.existsSync(yamlPath)) return [];
      const raw = fs.readFileSync(yamlPath, "utf-8");
      const parsed = parseYaml(raw);
      if (!Array.isArray(parsed)) {
        console.warn(`[hooks] hooks.yaml should be an array of hook configs`);
        return [];
      }
      // Validate each entry
      const valid: YamlHookConfig[] = [];
      for (const entry of parsed) {
        if (!entry.event || !entry.command) {
          console.warn(`[hooks] Skipping invalid YAML hook (missing event or command):`, entry);
          continue;
        }
        if (!["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "OnError"].includes(entry.event)) {
          console.warn(`[hooks] Unknown event "${entry.event}", skipping`);
          continue;
        }
        valid.push({
          event: entry.event,
          matcher: entry.matcher || "*",
          command: entry.command,
          timeout: typeof entry.timeout === "number" ? entry.timeout : DEFAULT_YAML_TIMEOUT,
        });
      }
      return valid;
    } catch (err) {
      console.warn(`[hooks] Failed to load hooks.yaml: ${err}`);
      return [];
    }
  }

  /**
   * Reload YAML hooks from disk (useful after editing hooks.yaml)
   */
  reloadYamlHooks(): number {
    this.yamlHooks = this.loadYamlHooks();
    return this.yamlHooks.length;
  }

  /**
   * Fire YAML hooks for a given event.
   *
   * Sends payload as JSON to stdin, reads stdout as JSON.
   * If any hook returns { block: true, reason: "..." }, the result is blocked.
   *
   * Hooks that fail or timeout are logged but do not crash the agent.
   */
  async fire(
    event: YamlHookEvent,
    payload: Record<string, unknown>,
  ): Promise<YamlHookFireResult> {
    const toolName = payload.tool as string | undefined;
    const matching = this.yamlHooks.filter(
      (h) => h.event === event && matchesToolName(h.matcher, toolName),
    );

    if (matching.length === 0) {
      return { blocked: false, hookResults: [] };
    }

    const hookResults: YamlHookFireResult["hookResults"] = [];
    let blocked = false;
    let blockReason: string | undefined;

    for (const hook of matching) {
      const result = await runYamlHookCommand(
        hook.command,
        payload,
        hook.timeout ?? DEFAULT_YAML_TIMEOUT,
        this.workingDirectory,
      );

      hookResults.push({
        command: hook.command,
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
      });

      if (!result.success) {
        console.warn(`[hooks] YAML hook failed: ${hook.command} - ${result.error}`);
        continue;
      }

      // Check for blocking response
      if (
        result.output &&
        typeof result.output === "object" &&
        (result.output as Record<string, unknown>).block === true
      ) {
        blocked = true;
        blockReason = String((result.output as Record<string, unknown>).reason || "Blocked by hook");
        break; // First block wins
      }
    }

    return { blocked, reason: blockReason, hookResults };
  }

  /**
   * Get loaded YAML hooks count
   */
  getYamlHookCount(): number {
    return this.yamlHooks.length;
  }

  /**
   * Save hooks configuration to disk
   */
  saveConfig(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Execute all hooks of a given type
   */
  async executeHooks(type: HookType, context: Partial<HookContext> = {}): Promise<HookResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    const hooks = this.config.hooks.filter(h => h.type === type && h.enabled);
    const results: HookResult[] = [];

    const fullContext: HookContext = {
      sessionId: this.sessionId,
      timestamp: new Date(),
      workingDirectory: this.workingDirectory,
      ...context,
    };

    for (const hook of hooks) {
      const result = await this.executeHook(hook, fullContext);
      results.push(result);
      this.results.push(result);

      // Stop if hook failed and continueOnError is false
      if (!result.success && !hook.continueOnError) {
        console.warn(`Hook '${hook.name}' failed and continueOnError=false. Stopping hook chain.`);
        break;
      }
    }

    return results;
  }

  /**
   * Execute a single hook
   */
  async executeHook(hook: Hook, context: HookContext): Promise<HookResult> {
    const startTime = Date.now();

    try {
      let output: string;

      switch (hook.mode) {
        case "shell":
          output = await this.executeShellHook(hook, context);
          break;
        case "script":
          output = await this.executeScriptHook(hook, context);
          break;
        case "function":
          output = await this.executeFunctionHook(hook, context);
          break;
        default:
          throw new Error(`Unknown hook mode: ${hook.mode}`);
      }

      return {
        hookId: hook.id,
        success: true,
        output,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        hookId: hook.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a shell command hook
   */
  private async executeShellHook(hook: Hook, context: HookContext): Promise<string> {
    if (!hook.command) {
      throw new Error("Shell hook missing command");
    }

    // Substitute variables in command
    const command = this.substituteVariables(hook.command, context);
    const timeout = hook.timeout || this.config.globalTimeout;

    return new Promise((resolve, reject) => {
      const proc = spawn("sh", ["-c", command], {
        cwd: this.workingDirectory,
        env: {
          ...process.env,
          EIGHGENT_SESSION_ID: context.sessionId,
          EIGHGENT_TOOL: context.tool || "",
          EIGHGENT_COMMAND: context.command || "",
          EIGHGENT_RESULT: context.result || "",
          EIGHGENT_ERROR: context.error || "",
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Hook timed out after ${timeout}ms`));
      }, timeout);

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Hook exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      // If async mode, resolve immediately
      if (hook.async) {
        clearTimeout(timeoutId);
        resolve("Hook started asynchronously");
      }
    });
  }

  /**
   * Execute a script file hook
   */
  private async executeScriptHook(hook: Hook, context: HookContext): Promise<string> {
    if (!hook.scriptPath) {
      throw new Error("Script hook missing scriptPath");
    }

    const scriptPath = path.isAbsolute(hook.scriptPath)
      ? hook.scriptPath
      : path.join(os.homedir(), ".8gent", "hooks", hook.scriptPath);

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Hook script not found: ${scriptPath}`);
    }

    // Determine interpreter based on extension
    const ext = path.extname(scriptPath).toLowerCase();
    let interpreter: string;
    switch (ext) {
      case ".js":
      case ".mjs":
        interpreter = "node";
        break;
      case ".ts":
        interpreter = "bun";
        break;
      case ".py":
        interpreter = "python3";
        break;
      case ".rb":
        interpreter = "ruby";
        break;
      case ".sh":
      case ".bash":
        interpreter = "bash";
        break;
      default:
        interpreter = "sh";
    }

    const timeout = hook.timeout || this.config.globalTimeout;

    return new Promise((resolve, reject) => {
      const proc = spawn(interpreter, [scriptPath], {
        cwd: this.workingDirectory,
        env: {
          ...process.env,
          EIGHGENT_CONTEXT: JSON.stringify(context),
          EIGHGENT_SESSION_ID: context.sessionId,
          EIGHGENT_TOOL: context.tool || "",
          EIGHGENT_COMMAND: context.command || "",
          EIGHGENT_RESULT: context.result || "",
          EIGHGENT_ERROR: context.error || "",
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Script hook timed out after ${timeout}ms`));
      }, timeout);

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Script hook exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  /**
   * Execute an inline function hook
   */
  private async executeFunctionHook(hook: Hook, context: HookContext): Promise<string> {
    if (!hook.functionBody) {
      throw new Error("Function hook missing functionBody");
    }

    try {
      // Create a sandboxed function from the body
      // The function receives context as its argument
      const fn = new Function("context", hook.functionBody);
      const result = await fn(context);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      throw new Error(`Function hook error: ${err}`);
    }
  }

  /**
   * Substitute variables in a string
   * Supports: {tool}, {result}, {error}, {command}, {sessionId}, {timestamp}
   */
  private substituteVariables(template: string, context: HookContext): string {
    return template
      .replace(/\{tool\}/g, context.tool || "")
      .replace(/\{result\}/g, context.result || "")
      .replace(/\{error\}/g, context.error || "")
      .replace(/\{command\}/g, context.command || "")
      .replace(/\{sessionId\}/g, context.sessionId)
      .replace(/\{timestamp\}/g, context.timestamp.toISOString())
      .replace(/\{workingDirectory\}/g, context.workingDirectory)
      .replace(/\{stdout\}/g, context.stdout || "")
      .replace(/\{stderr\}/g, context.stderr || "")
      .replace(/\{exitCode\}/g, String(context.exitCode ?? ""))
      .replace(/\{duration\}/g, String(context.duration ?? ""))
      .replace(/\{tokenCount\}/g, String(context.tokenCount ?? ""));
  }

  // ============================================
  // Hook Management
  // ============================================

  /**
   * Register a new hook
   */
  registerHook(hook: Omit<Hook, "id">): Hook {
    const newHook: Hook = {
      ...hook,
      id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    this.config.hooks.push(newHook);
    this.saveConfig();
    return newHook;
  }

  /**
   * Unregister a hook by ID
   */
  unregisterHook(hookId: string): boolean {
    const index = this.config.hooks.findIndex(h => h.id === hookId);
    if (index === -1) return false;

    this.config.hooks.splice(index, 1);
    this.saveConfig();
    return true;
  }

  /**
   * Enable a hook
   */
  enableHook(hookId: string): boolean {
    const hook = this.config.hooks.find(h => h.id === hookId);
    if (!hook) return false;

    hook.enabled = true;
    this.saveConfig();
    return true;
  }

  /**
   * Disable a hook
   */
  disableHook(hookId: string): boolean {
    const hook = this.config.hooks.find(h => h.id === hookId);
    if (!hook) return false;

    hook.enabled = false;
    this.saveConfig();
    return true;
  }

  /**
   * Get all hooks
   */
  getAllHooks(): Hook[] {
    return [...this.config.hooks];
  }

  /**
   * Get hooks by type
   */
  getHooksByType(type: HookType): Hook[] {
    return this.config.hooks.filter(h => h.type === type);
  }

  /**
   * Get hook by ID
   */
  getHook(hookId: string): Hook | undefined {
    return this.config.hooks.find(h => h.id === hookId);
  }

  /**
   * Update a hook
   */
  updateHook(hookId: string, updates: Partial<Hook>): boolean {
    const hook = this.config.hooks.find(h => h.id === hookId);
    if (!hook) return false;

    Object.assign(hook, updates);
    this.saveConfig();
    return true;
  }

  /**
   * Enable/disable global hooks
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.saveConfig();
  }

  /**
   * Check if hooks are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Set working directory
   */
  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
  }

  /**
   * Get execution results
   */
  getResults(): HookResult[] {
    return [...this.results];
  }

  /**
   * Clear results
   */
  clearResults(): void {
    this.results = [];
  }

  /**
   * Get configuration
   */
  getConfig(): HooksConfig {
    return { ...this.config };
  }
}

// ============================================
// Singleton Instance
// ============================================

let hookManagerInstance: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!hookManagerInstance) {
    hookManagerInstance = new HookManager();
  }
  return hookManagerInstance;
}

export function resetHookManager(): void {
  hookManagerInstance?.clearResults();
  hookManagerInstance = null;
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Execute hooks for a specific type (convenience function)
 */
export async function executeHooks(type: HookType, context?: Partial<HookContext>): Promise<HookResult[]> {
  return getHookManager().executeHooks(type, context);
}

/**
 * Register a simple shell hook
 */
export function registerShellHook(
  type: HookType,
  name: string,
  command: string,
  options?: Partial<Hook>
): Hook {
  return getHookManager().registerHook({
    type,
    name,
    mode: "shell",
    command,
    enabled: true,
    ...options,
  });
}

/**
 * Register a script hook
 */
export function registerScriptHook(
  type: HookType,
  name: string,
  scriptPath: string,
  options?: Partial<Hook>
): Hook {
  return getHookManager().registerHook({
    type,
    name,
    mode: "script",
    scriptPath,
    enabled: true,
    ...options,
  });
}

/**
 * Register a function hook
 */
export function registerFunctionHook(
  type: HookType,
  name: string,
  fn: (context: HookContext) => unknown,
  options?: Partial<Hook>
): Hook {
  return getHookManager().registerHook({
    type,
    name,
    mode: "function",
    functionBody: `return (${fn.toString()})(context)`,
    enabled: true,
    ...options,
  });
}

/**
 * Register a hook directly
 */
export function registerHook(hookConfig: Omit<Hook, "id">): Hook {
  return getHookManager().registerHook(hookConfig);
}

// ============================================
// Voice Hook Exports
// ============================================

export {
  configureVoice,
  getVoiceConfig,
  extractCompletionMessage,
  speak,
  voiceCompletionHook,
  generateCompletionVoice,
  setupVoiceHook,
  testVoice,
} from "./voice.js";
