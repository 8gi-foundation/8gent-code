/**
 * @8gent/policy — Policy YAML Parser
 *
 * Parses .8gent/policy.yaml into a strongly-typed Policy object.
 * Provides glob matching and sensible default policies.
 */

import YAML from "yaml";
import { minimatch } from "minimatch";
import * as os from "os";
import type { Policy, PolicyRules, FilesystemRules, CommandRules, NetworkRules, InferenceRules } from "./schema.js";

// ============================================
// Glob Matching
// ============================================

/**
 * Match a target path/string against a glob pattern.
 * Expands ~ to the user's home directory before matching.
 */
export function matchesPattern(target: string, pattern: string): boolean {
  const home = os.homedir();
  const expandedPattern = pattern.replace(/^~/, home);
  const expandedTarget = target.replace(/^~/, home);

  return minimatch(expandedTarget, expandedPattern, {
    dot: true,
    matchBase: false,
    nocase: process.platform === "darwin",
  });
}

/**
 * Check if a target matches any pattern in a list.
 */
export function matchesAnyPattern(target: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(target, pattern));
}

// ============================================
// Default Policy
// ============================================

const DEFAULT_FILESYSTEM: FilesystemRules = {
  allow: [
    "~/projects/**",
    "/tmp/**",
    "./**",
  ],
  deny: [
    "~/.ssh/**",
    "~/.env*",
    "~/.gnupg/**",
    "~/.aws/credentials",
    "**/node_modules/**",
    "**/.git/objects/**",
  ],
  requireApproval: [
    "**/package.json",
    "**/tsconfig.json",
    "**/.env*",
  ],
};

const DEFAULT_COMMANDS: CommandRules = {
  allow: [
    "git *",
    "npm *",
    "npx *",
    "bun *",
    "node *",
    "tsc *",
    "eslint *",
    "prettier *",
    "cat *",
    "ls *",
    "find *",
    "grep *",
    "head *",
    "tail *",
    "wc *",
    "echo *",
  ],
  deny: [
    "rm -rf /*",
    "rm -rf ~/*",
    "sudo *",
    "curl * | bash",
    "wget * | bash",
    "chmod 777 *",
    "shutdown *",
    "reboot *",
    "mkfs *",
    "dd *",
  ],
  requireApproval: [
    "git push --force*",
    "git push -f *",
    "git reset --hard*",
    "git clean -fd*",
    "rm -rf *",
    "npm publish*",
  ],
};

const DEFAULT_NETWORK: NetworkRules = {
  allow: [
    "api.anthropic.com",
    "api.openai.com",
    "openrouter.ai",
    "api.openrouter.ai",
    "localhost:*",
    "127.0.0.1:*",
    "registry.npmjs.org",
    "github.com",
    "api.github.com",
  ],
  deny: [
    "*",
  ],
};

const DEFAULT_INFERENCE: InferenceRules = {
  localOnly: [
    "*.env*",
    "*credentials*",
    "*secret*",
    "*.pem",
    "*.key",
    "*password*",
    "*.p12",
    "*token*",
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
  ],
  cloudAllowed: [
    "*.md",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.json",
    "*.yaml",
    "*.yml",
    "*.css",
    "*.html",
    "*.svg",
    "*.txt",
  ],
};

/**
 * Returns sensible default policy when no policy.yaml is found.
 */
export function getDefaultPolicy(): Policy {
  return {
    version: 1,
    rules: {
      filesystem: { ...DEFAULT_FILESYSTEM },
      commands: { ...DEFAULT_COMMANDS },
      network: { ...DEFAULT_NETWORK },
      inference: { ...DEFAULT_INFERENCE },
    },
  };
}

// ============================================
// YAML Parser
// ============================================

function ensureStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

function parseFilesystem(raw: Record<string, unknown> | undefined): FilesystemRules {
  const defaults = DEFAULT_FILESYSTEM;
  if (!raw) return { ...defaults };
  return {
    allow: ensureStringArray(raw.allow ?? defaults.allow),
    deny: ensureStringArray(raw.deny ?? defaults.deny),
    requireApproval: ensureStringArray(raw.requireApproval ?? defaults.requireApproval),
  };
}

function parseCommands(raw: Record<string, unknown> | undefined): CommandRules {
  const defaults = DEFAULT_COMMANDS;
  if (!raw) return { ...defaults };
  return {
    allow: ensureStringArray(raw.allow ?? defaults.allow),
    deny: ensureStringArray(raw.deny ?? defaults.deny),
    requireApproval: ensureStringArray(raw.requireApproval ?? defaults.requireApproval),
  };
}

function parseNetwork(raw: Record<string, unknown> | undefined): NetworkRules {
  const defaults = DEFAULT_NETWORK;
  if (!raw) return { ...defaults };
  return {
    allow: ensureStringArray(raw.allow ?? defaults.allow),
    deny: ensureStringArray(raw.deny ?? defaults.deny),
  };
}

function parseInference(raw: Record<string, unknown> | undefined): InferenceRules {
  const defaults = DEFAULT_INFERENCE;
  if (!raw) return { ...defaults };
  return {
    localOnly: ensureStringArray(raw.localOnly ?? defaults.localOnly),
    cloudAllowed: ensureStringArray(raw.cloudAllowed ?? defaults.cloudAllowed),
  };
}

/**
 * Parse a YAML string into a validated Policy object.
 * Falls back to defaults for any missing sections.
 */
export function parsePolicy(yamlContent: string): Policy {
  const doc = YAML.parse(yamlContent) as Record<string, unknown>;

  if (!doc || typeof doc !== "object") {
    return getDefaultPolicy();
  }

  const version = typeof doc.version === "number" ? doc.version : 1;
  const rawRules = (doc.rules ?? {}) as Record<string, Record<string, unknown>>;

  return {
    version,
    rules: {
      filesystem: parseFilesystem(rawRules.filesystem),
      commands: parseCommands(rawRules.commands),
      network: parseNetwork(rawRules.network),
      inference: parseInference(rawRules.inference),
    },
  };
}
