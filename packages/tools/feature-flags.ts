/**
 * Feature Flags - Simple flag system for 8gent
 *
 * Reads flags from ~/.8gent/flags.json
 * Supports: boolean, percentage rollout, user-based targeting
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";

const FLAGS_PATH = join(homedir(), ".8gent", "flags.json");

export interface BooleanFlag {
  type: "boolean";
  enabled: boolean;
}

export interface PercentageFlag {
  type: "percentage";
  percentage: number; // 0-100
}

export interface UserTargetFlag {
  type: "user-target";
  enabled: string[]; // user IDs that get the flag
  default?: boolean;
}

export type FlagDefinition = BooleanFlag | PercentageFlag | UserTargetFlag;

export interface FlagsFile {
  [flagName: string]: FlagDefinition;
}

let cached: { flags: FlagsFile; mtime: number } | null = null;

/** Load flags from disk with simple mtime cache */
function loadFlags(): FlagsFile {
  if (!existsSync(FLAGS_PATH)) return {};

  try {
    const stat = Bun.file(FLAGS_PATH);
    const mtime = stat.lastModified;

    if (cached && cached.mtime === mtime) return cached.flags;

    const raw = readFileSync(FLAGS_PATH, "utf-8");
    const flags: FlagsFile = JSON.parse(raw);
    cached = { flags, mtime };
    return flags;
  } catch {
    return {};
  }
}

/** Deterministic hash for percentage rollout - same user always gets same result */
function hashToPercent(flagName: string, userId: string): number {
  const hash = createHash("sha256")
    .update(`${flagName}:${userId}`)
    .digest("hex");
  const value = parseInt(hash.slice(0, 8), 16);
  return value % 100;
}

/** Check if a flag is enabled */
export function isEnabled(flagName: string, userId?: string): boolean {
  const flags = loadFlags();
  const flag = flags[flagName];

  if (!flag) return false;

  switch (flag.type) {
    case "boolean":
      return flag.enabled;

    case "percentage": {
      const id = userId ?? "anonymous";
      return hashToPercent(flagName, id) < flag.percentage;
    }

    case "user-target": {
      if (!userId) return flag.default ?? false;
      return flag.enabled.includes(userId);
    }

    default:
      return false;
  }
}

/** Get all flag names and their raw definitions */
export function listFlags(): FlagsFile {
  return { ...loadFlags() };
}

/** Invalidate the in-memory cache (useful after writing new flags) */
export function invalidateCache(): void {
  cached = null;
}
