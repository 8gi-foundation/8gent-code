/**
 * 8gent Environment Variable Manager
 *
 * Reads .env, .env.local, and process environment.
 * Lists, validates, and masks 8gent-related env vars.
 *
 * Usage:
 *   bun run packages/tools/env-manager.ts list
 *   bun run packages/tools/env-manager.ts check
 *   bun run packages/tools/env-manager.ts set KEY=VALUE
 */

import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";

// --- Config ---

const PROJECT_ROOT = join(import.meta.dir, "../..");

const ENV_FILES = [
  join(PROJECT_ROOT, ".env"),
  join(PROJECT_ROOT, ".env.local"),
] as const;

const KNOWN_VARS: Record<string, { required: boolean; secret: boolean; description: string }> = {
  OPENROUTER_API_KEY:    { required: false, secret: true,  description: "OpenRouter cloud model access" },
  ANTHROPIC_API_KEY:     { required: false, secret: true,  description: "Anthropic API (Claude models)" },
  OLLAMA_URL:            { required: false, secret: false, description: "Ollama server URL (default localhost:11434)" },
  TELEGRAM_BOT_TOKEN:    { required: false, secret: true,  description: "Telegram bot token for notifications" },
  TELEGRAM_CHAT_ID:      { required: false, secret: false, description: "Telegram chat ID for notifications" },
  EIGHGENT_MODEL:        { required: false, secret: false, description: "Default model override" },
  EIGHGENT_RUNTIME:      { required: false, secret: false, description: "Runtime override (ollama|openrouter)" },
  EIGHT_DATA_DIR:        { required: false, secret: false, description: "Data directory (default ~/.8gent)" },
  EIGHT_VESSEL_CONTEXT:  { required: false, secret: false, description: "Vessel daemon context" },
  EIGHT_OAUTH_CLIENT_ID: { required: false, secret: true,  description: "OAuth client ID" },
  EIGHT_DEVICE_AUTH_ENDPOINT: { required: false, secret: false, description: "Device auth endpoint" },
  REPLICATE_API_KEY:     { required: false, secret: true,  description: "Replicate API for music generation" },
  STRIPE_SECRET_KEY:     { required: false, secret: true,  description: "Stripe billing secret" },
  STRIPE_WEBHOOK_SECRET: { required: false, secret: true,  description: "Stripe webhook secret" },
  CLERK_SECRET_KEY:      { required: false, secret: true,  description: "Clerk auth secret" },
  CLERK_PUBLISHABLE_KEY: { required: false, secret: false, description: "Clerk auth publishable key" },
  TTS_SERVER_URL:        { required: false, secret: false, description: "TTS server URL" },
};

// --- Helpers ---

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function loadAll(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const f of ENV_FILES) Object.assign(merged, parseEnvFile(f));
  // Process env wins
  for (const key of Object.keys(KNOWN_VARS)) {
    if (process.env[key]) merged[key] = process.env[key]!;
  }
  return merged;
}

function mask(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "***";
}

function display(key: string, value: string | undefined, meta: typeof KNOWN_VARS[string]): string {
  const status = value ? "SET" : "UNSET";
  const shown = value ? (meta.secret ? mask(value) : value) : "-";
  return `  ${status.padEnd(6)} ${key.padEnd(30)} ${shown.padEnd(20)} ${meta.description}`;
}

// --- Commands ---

function list() {
  const vars = loadAll();
  console.log("\n8gent Environment Variables\n");
  console.log(`  ${"STATUS".padEnd(6)} ${"VARIABLE".padEnd(30)} ${"VALUE".padEnd(20)} DESCRIPTION`);
  console.log(`  ${"-".repeat(6)} ${"-".repeat(30)} ${"-".repeat(20)} ${"-".repeat(30)}`);
  for (const [key, meta] of Object.entries(KNOWN_VARS)) {
    console.log(display(key, vars[key], meta));
  }
  const sources = ENV_FILES.filter(existsSync).map((f) => f.replace(PROJECT_ROOT, "."));
  console.log(`\nSources: ${sources.length ? sources.join(", ") : "none"} + process.env\n`);
}

function check() {
  const vars = loadAll();
  const missing: string[] = [];
  const secrets: string[] = [];
  for (const [key, meta] of Object.entries(KNOWN_VARS)) {
    if (meta.required && !vars[key]) missing.push(key);
    if (meta.secret && vars[key]) secrets.push(key);
  }
  const total = Object.keys(KNOWN_VARS).length;
  const set = Object.keys(KNOWN_VARS).filter((k) => vars[k]).length;
  console.log(`\nEnvironment check: ${set}/${total} vars set`);
  if (missing.length) {
    console.log(`MISSING required: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (secrets.length) console.log(`Secrets loaded: ${secrets.join(", ")}`);
  console.log("All required vars OK\n");
}

function set(pair: string) {
  const eqIdx = pair.indexOf("=");
  if (eqIdx === -1) { console.error("Usage: set KEY=VALUE"); process.exit(1); }
  const key = pair.slice(0, eqIdx);
  const value = pair.slice(eqIdx + 1);
  const target = join(PROJECT_ROOT, ".env.local");
  const existing = parseEnvFile(target);
  if (existing[key]) {
    // Replace in file
    let content = existsSync(target) ? readFileSync(target, "utf-8") : "";
    const regex = new RegExp(`^${key}=.*$`, "m");
    content = content.replace(regex, `${key}=${value}`);
    Bun.write(target, content);
  } else {
    appendFileSync(target, `\n${key}=${value}\n`);
  }
  const meta = KNOWN_VARS[key];
  const shown = meta?.secret ? mask(value) : value;
  console.log(`Set ${key}=${shown} in .env.local`);
}

// --- CLI ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "list":  list(); break;
  case "check": check(); break;
  case "set":   set(args[0] || ""); break;
  default:
    console.log("Usage: bun run packages/tools/env-manager.ts [list|check|set KEY=VALUE]");
    if (!cmd) process.exit(0);
    process.exit(1);
}
