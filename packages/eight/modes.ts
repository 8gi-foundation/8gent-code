/**
 * 8gent Code - Agent Mode System
 *
 * Scoped agent personas with tool permissions.
 * 5 built-in modes + user-defined custom modes via ~/.8gent/modes.yaml
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";

export interface AgentMode {
  name: string;
  description: string;
  systemPromptPrefix: string;
  allowedTools?: string[];
  deniedTools?: string[];
  effort?: "low" | "medium" | "high";
}

const BUILT_IN_MODES: Record<string, AgentMode> = {
  code: {
    name: "Code",
    description: "Full coding agent - all tools available",
    systemPromptPrefix: "You are a coding agent. Write, test, and ship code.",
    effort: "high",
  },
  architect: {
    name: "Architect",
    description: "Read-only planning mode - no file writes",
    systemPromptPrefix: "You are a software architect. Analyze, plan, and design. Do NOT write code.",
    deniedTools: ["write_file", "edit_file", "run_command", "git_commit", "git_push"],
    effort: "high",
  },
  review: {
    name: "Review",
    description: "Code review mode - read-only with feedback",
    systemPromptPrefix: "You are a code reviewer. Read code, find issues, suggest improvements. Do NOT modify files.",
    deniedTools: ["write_file", "edit_file", "run_command", "git_commit", "git_push"],
    effort: "medium",
  },
  debug: {
    name: "Debug",
    description: "Debugging mode - verbose, all tools, extra logging",
    systemPromptPrefix: "You are debugging. Be verbose about your reasoning. Check assumptions. Read error messages carefully.",
    effort: "high",
  },
  ask: {
    name: "Ask",
    description: "Question mode - no tools, just conversation",
    systemPromptPrefix: "Answer questions conversationally. Do NOT use tools unless explicitly asked.",
    allowedTools: [],
    effort: "low",
  },
};

function loadCustomModes(filePath: string): Record<string, AgentMode> {
  const result: Record<string, AgentMode> = {};
  if (!fs.existsSync(filePath)) return result;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw) as { modes?: Record<string, any> };
    if (!parsed?.modes || typeof parsed.modes !== "object") return result;
    for (const [key, val] of Object.entries(parsed.modes)) {
      if (!val || typeof val !== "object") continue;
      const m = val as Record<string, any>;
      result[key] = {
        name: m.name || key,
        description: m.description || "",
        systemPromptPrefix: m.systemPromptPrefix || m.prompt || "",
        allowedTools: Array.isArray(m.allowedTools) ? m.allowedTools : undefined,
        deniedTools: Array.isArray(m.deniedTools) ? m.deniedTools : undefined,
        effort: ["low", "medium", "high"].includes(m.effort) ? m.effort : undefined,
      };
    }
  } catch (err) {
    console.warn(`[modes] Failed to load custom modes from ${filePath}: ${err}`);
  }
  return result;
}

export class ModeManager {
  private modes: Record<string, AgentMode>;
  private active: string = "code";

  constructor(customModesPath?: string) {
    const modesPath = customModesPath || path.join(
      process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
      "modes.yaml"
    );
    this.modes = { ...BUILT_IN_MODES, ...loadCustomModes(modesPath) };
  }

  getMode(name: string): AgentMode | null {
    return this.modes[name.toLowerCase()] || null;
  }

  listModes(): AgentMode[] { return Object.values(this.modes); }
  getActiveMode(): AgentMode { return this.modes[this.active] || BUILT_IN_MODES.code; }
  getActiveModeKey(): string { return this.active; }

  setActiveMode(name: string): boolean {
    const key = name.toLowerCase();
    if (!this.modes[key]) return false;
    this.active = key;
    return true;
  }

  filterTools<T extends { name: string }>(tools: T[]): T[] {
    const mode = this.getActiveMode();
    if (mode.allowedTools !== undefined) {
      if (mode.allowedTools.length === 0) return [];
      const allowed = new Set(mode.allowedTools);
      return tools.filter((t) => allowed.has(t.name));
    }
    if (mode.deniedTools?.length) {
      const denied = new Set(mode.deniedTools);
      return tools.filter((t) => !denied.has(t.name));
    }
    return tools;
  }

  isToolAllowed(toolName: string): boolean {
    const mode = this.getActiveMode();
    if (mode.allowedTools !== undefined) return mode.allowedTools.includes(toolName);
    if (mode.deniedTools?.length) return !mode.deniedTools.includes(toolName);
    return true;
  }
}

let _instance: ModeManager | null = null;
export function getModeManager(): ModeManager {
  if (!_instance) _instance = new ModeManager();
  return _instance;
}
export function resetModeManager(): void { _instance = null; }
