/**
 * FeatureFlags - manages feature flags with percentage-based rollout and user targeting.
 *
 * Supports:
 * - Named flags with default on/off state
 * - Rollout percentage (0-100) for gradual deployment
 * - User-level targeting (allow/block lists)
 * - Runtime overrides (for testing or emergency kill switches)
 * - Config-driven flag definitions (JSON or object)
 */

export interface FlagDefinition {
  name: string;
  description?: string;
  enabled: boolean;
  rollout: number;
  allowlist?: string[];
  blocklist?: string[];
}

export interface FlagConfig {
  flags: FlagDefinition[];
}

export type Override = boolean | "force-on" | "force-off";

function hashUserId(userId: string, flagName: string): number {
  const key = `${flagName}:${userId}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) ^ key.charCodeAt(i);
    h = h >>> 0;
  }
  return h % 100;
}

export class FeatureFlags {
  private flags: Map<string, FlagDefinition> = new Map();
  private overrides: Map<string, Override> = new Map();

  constructor(config?: FlagConfig | FlagDefinition[]) {
    if (config) {
      this.load(config);
    }
  }

  /**
   * Load flags from a config object or array of definitions.
   * Merges with any existing flags.
   */
  load(config: FlagConfig | FlagDefinition[]): void {
    const defs = Array.isArray(config) ? config : config.flags;
    for (const def of defs) {
      if (def.rollout < 0 || def.rollout > 100) {
        throw new RangeError(`Flag "${def.name}" rollout must be 0-100, got ${def.rollout}`);
      }
      this.flags.set(def.name, { ...def });
    }
  }

  /**
   * Load flags from a JSON string.
   */
  loadJSON(json: string): void {
    const parsed = JSON.parse(json) as FlagConfig | FlagDefinition[];
    this.load(parsed);
  }

  /**
   * Check whether a flag is enabled for an optional user ID.
   *
   * Evaluation order:
   * 1. Runtime override
   * 2. Blocklist - always off
   * 3. Allowlist - always on
   * 4. Rollout bucket (deterministic per userId + flagName)
   * 5. Global enabled default
   */
  isEnabled(flagName: string, userId?: string): boolean {
    const override = this.overrides.get(flagName);
    if (override !== undefined) {
      return override === true || override === "force-on";
    }

    const def = this.flags.get(flagName);
    if (!def) return false;

    if (userId) {
      if (def.blocklist?.includes(userId)) return false;
      if (def.allowlist?.includes(userId)) return true;
    }

    if (def.rollout === 100) return def.enabled;
    if (def.rollout === 0) return false;

    if (userId) {
      const bucket = hashUserId(userId, flagName);
      return bucket < def.rollout;
    }

    return def.enabled;
  }

  /**
   * Set a runtime override. Pass null to clear.
   */
  override(flagName: string, value: Override | null): void {
    if (value === null) {
      this.overrides.delete(flagName);
    } else {
      this.overrides.set(flagName, value);
    }
  }

  getDefinition(flagName: string): FlagDefinition | undefined {
    const def = this.flags.get(flagName);
    return def ? { ...def } : undefined;
  }

  list(): string[] {
    return Array.from(this.flags.keys());
  }
}
