/**
 * config-loader.ts
 *
 * Loads config from multiple sources with explicit precedence:
 *   CLI args > env vars > config file > defaults
 *
 * Supports nested keys via dot notation ("server.port").
 */

import { readFileSync, existsSync } from "fs";
import { extname } from "path";

export type ConfigValue = string | number | boolean | null;
export type ConfigMap = Record<string, unknown>;

export interface ConfigOptions {
  /** Default values - lowest precedence */
  defaults?: ConfigMap;
  /** Path to a .json or .yaml/.yml file */
  filePath?: string;
  /** Env var prefix. e.g. "APP_" maps APP_SERVER_PORT -> server.port */
  envPrefix?: string;
  /** Raw CLI args (defaults to process.argv.slice(2)) */
  cliArgs?: string[];
}

// ---- helpers ----------------------------------------------------------------

function setNested(obj: ConfigMap, dotKey: string, value: unknown): void {
  const parts = dotKey.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cursor[k] == null || typeof cursor[k] !== "object") {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function deepMerge(target: ConfigMap, source: ConfigMap): ConfigMap {
  const result: ConfigMap = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as ConfigMap, sv as ConfigMap);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function coerce(raw: string): ConfigValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== "") return n;
  return raw;
}

// ---- source loaders ---------------------------------------------------------

function loadFile(filePath: string): ConfigMap {
  if (!existsSync(filePath)) return {};
  const ext = extname(filePath).toLowerCase();
  const raw = readFileSync(filePath, "utf8");
  if (ext === ".json") {
    return JSON.parse(raw) as ConfigMap;
  }
  if (ext === ".yaml" || ext === ".yml") {
    // Minimal YAML: key: value lines only (no deps required)
    const result: ConfigMap = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      setNested(result, k, coerce(v));
    }
    return result;
  }
  throw new Error(`config-loader: unsupported file type '${ext}'`);
}

function loadEnv(prefix: string): ConfigMap {
  const result: ConfigMap = {};
  const p = prefix.toUpperCase();
  for (const [rawKey, rawVal] of Object.entries(process.env)) {
    if (!rawKey.startsWith(p)) continue;
    const stripped = rawKey.slice(p.length).toLowerCase().replace(/_/g, ".");
    setNested(result, stripped, coerce(rawVal ?? ""));
  }
  return result;
}

function loadCli(args: string[]): ConfigMap {
  const result: ConfigMap = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // --key=value
    const eqMatch = arg.match(/^--([^=]+)=(.*)$/);
    if (eqMatch) {
      setNested(result, eqMatch[1], coerce(eqMatch[2]));
      continue;
    }
    // --key value (next arg is value unless it starts with --)
    const flagMatch = arg.match(/^--(.+)$/);
    if (flagMatch) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        setNested(result, flagMatch[1], coerce(next));
        i++;
      } else {
        setNested(result, flagMatch[1], true);
      }
    }
  }
  return result;
}

// ---- public API -------------------------------------------------------------

export function loadConfig(options: ConfigOptions = {}): ConfigMap {
  const {
    defaults = {},
    filePath,
    envPrefix = "",
    cliArgs = process.argv.slice(2),
  } = options;

  let config: ConfigMap = { ...defaults };

  if (filePath) {
    config = deepMerge(config, loadFile(filePath));
  }

  if (envPrefix) {
    config = deepMerge(config, loadEnv(envPrefix));
  }

  config = deepMerge(config, loadCli(cliArgs));

  return config;
}

export class ConfigLoader {
  private config: ConfigMap;

  constructor(options: ConfigOptions = {}) {
    this.config = loadConfig(options);
  }

  get<T = unknown>(dotKey: string, fallback?: T): T {
    const parts = dotKey.split(".");
    let cursor: unknown = this.config;
    for (const part of parts) {
      if (cursor == null || typeof cursor !== "object") return fallback as T;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return (cursor ?? fallback) as T;
  }

  all(): ConfigMap {
    return { ...this.config };
  }

  reload(options: ConfigOptions): void {
    this.config = loadConfig(options);
  }
}
