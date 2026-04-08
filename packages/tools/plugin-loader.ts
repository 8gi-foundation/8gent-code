/**
 * 8gent Code - Plugin Loader
 *
 * Loads, validates, and manages third-party plugins.
 * See docs/PLUGIN-SPEC.md for the full specification.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

export interface PluginManifest {
  name: string;
  version: string;
  eight: {
    type: PluginType[];
    apiVersion: string;
    displayName: string;
    permissions: string[];
    entry?: string;
    config?: Record<string, { type: string; required?: boolean; description?: string }>;
    minEightVersion?: string;
  };
  main?: string;
}

export type PluginType = "tool" | "benchmark" | "theme" | "persona";

export interface PluginRegistryEntry {
  version: string;
  types: PluginType[];
  active: boolean;
  installedAt: string;
  permissions: Record<string, string[]>;
  entry: string;
}

export interface PluginRegistry {
  version: number;
  plugins: Record<string, PluginRegistryEntry>;
}

export interface PluginContext {
  registerTool: (def: ToolDefinition) => void;
  registerBenchmark: (def: unknown) => void;
  registerTheme: (def: unknown) => void;
  registerPersona: (def: unknown) => void;
  fetch: (url: string, opts?: RequestInit) => Promise<Response>;
  env: (name: string) => string | undefined;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  config: Record<string, unknown>;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; required?: boolean; description?: string }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface EightPlugin {
  name: string;
  version: string;
  activate: (ctx: PluginContext) => Promise<void>;
  deactivate: () => Promise<void>;
}

// ============================================
// Constants
// ============================================

const DATA_DIR = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const REGISTRY_PATH = path.join(PLUGINS_DIR, "registry.json");
const SUPPORTED_API_VERSION = "1";

// ============================================
// Plugin Loader
// ============================================

export class PluginLoader {
  private registry: PluginRegistry;
  private loaded: Map<string, EightPlugin> = new Map();
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registry = this.loadRegistry();
  }

  private loadRegistry(): PluginRegistry {
    if (fs.existsSync(REGISTRY_PATH)) {
      const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
      return JSON.parse(raw) as PluginRegistry;
    }
    return { version: 1, plugins: {} };
  }

  private saveRegistry(): void {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(this.registry, null, 2));
  }

  /** Validate a plugin manifest before install */
  validateManifest(manifest: PluginManifest): string[] {
    const errors: string[] = [];
    if (!manifest.name) errors.push("Missing plugin name");
    if (!manifest.version) errors.push("Missing plugin version");
    if (!manifest.eight) errors.push("Missing 'eight' field in package.json");
    if (manifest.eight) {
      if (!manifest.eight.type?.length) errors.push("Must declare at least one plugin type");
      if (manifest.eight.apiVersion !== SUPPORTED_API_VERSION) {
        errors.push(`Unsupported API version: ${manifest.eight.apiVersion} (need ${SUPPORTED_API_VERSION})`);
      }
      if (!manifest.eight.displayName) errors.push("Missing displayName");
      if (!Array.isArray(manifest.eight.permissions)) errors.push("Permissions must be an array");
    }
    return errors;
  }

  /** Register a plugin in the registry (does not activate) */
  register(manifest: PluginManifest, entryPath: string): void {
    const permissions: Record<string, string[]> = {};
    for (const perm of manifest.eight.permissions) {
      const [category, ...rest] = perm.split(":");
      const value = rest.join(":");
      if (!permissions[category]) permissions[category] = [];
      permissions[category].push(value);
    }
    this.registry.plugins[manifest.name] = {
      version: manifest.version,
      types: manifest.eight.type,
      active: false,
      installedAt: new Date().toISOString(),
      permissions,
      entry: entryPath,
    };
    this.saveRegistry();
  }

  /** Create a sandboxed PluginContext for a plugin */
  private createContext(name: string, entry: PluginRegistryEntry): PluginContext {
    const pluginDir = path.join(PLUGINS_DIR, name);
    const stateDir = path.join(pluginDir, "state");
    const allowedDomains = entry.permissions.network || [];
    const allowedEnvPatterns = entry.permissions.env || [];

    return {
      registerTool: (def: ToolDefinition) => {
        const prefixed = { ...def, name: `plugin:${name}:${def.name}` };
        this.tools.set(prefixed.name, prefixed);
      },
      registerBenchmark: () => { /* future */ },
      registerTheme: () => { /* future */ },
      registerPersona: () => { /* future */ },
      fetch: async (url: string, opts?: RequestInit) => {
        const hostname = new URL(url).hostname;
        const allowed = allowedDomains.some((d) => {
          if (d.startsWith("*.")) return hostname.endsWith(d.slice(1));
          return hostname === d;
        });
        if (!allowed) throw new Error(`Network access denied: ${hostname} not in allowed domains`);
        return globalThis.fetch(url, opts);
      },
      env: (varName: string) => {
        const allowed = allowedEnvPatterns.some((pattern) => {
          if (pattern.endsWith("*")) return varName.startsWith(pattern.slice(0, -1));
          return varName === pattern;
        });
        if (!allowed) return undefined;
        return process.env[varName];
      },
      readFile: async (filePath: string) => {
        const resolved = path.resolve(pluginDir, filePath);
        if (!resolved.startsWith(pluginDir)) throw new Error("File access denied: outside plugin directory");
        return fs.promises.readFile(resolved, "utf-8");
      },
      writeFile: async (filePath: string, data: string) => {
        const resolved = path.resolve(stateDir, filePath);
        if (!resolved.startsWith(stateDir)) throw new Error("Write access denied: outside state directory");
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        await fs.promises.writeFile(resolved, data);
      },
      config: {},
      log: (level, msg) => console.log(`[plugin:${name}] [${level}] ${msg}`),
    };
  }

  /** Activate a registered plugin */
  async activate(name: string): Promise<void> {
    const entry = this.registry.plugins[name];
    if (!entry) throw new Error(`Plugin not found: ${name}`);
    if (entry.active) return;

    const mod = await import(path.resolve(entry.entry));
    const plugin: EightPlugin = mod.default || mod;
    const ctx = this.createContext(name, entry);
    await plugin.activate(ctx);

    this.loaded.set(name, plugin);
    entry.active = true;
    this.saveRegistry();
  }

  /** Deactivate a loaded plugin */
  async deactivate(name: string): Promise<void> {
    const plugin = this.loaded.get(name);
    if (plugin) {
      await plugin.deactivate();
      this.loaded.delete(name);
    }
    // Remove plugin tools
    for (const key of this.tools.keys()) {
      if (key.startsWith(`plugin:${name}:`)) this.tools.delete(key);
    }
    const entry = this.registry.plugins[name];
    if (entry) {
      entry.active = false;
      this.saveRegistry();
    }
  }

  /** Get all registered tool definitions from active plugins */
  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** List all registered plugins */
  list(): Record<string, PluginRegistryEntry> {
    return { ...this.registry.plugins };
  }
}
