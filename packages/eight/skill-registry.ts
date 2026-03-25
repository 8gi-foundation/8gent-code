/**
 * 8gent Code - Skill Registry
 *
 * Registers skills with name, triggers, and handler. Matches input to skills
 * with priority resolution. Supports enable/disable per skill. Zero deps.
 *
 * Architecture:
 *   - SkillDefinition  -- the shape of a registered skill
 *   - SkillMatch       -- result of a match operation
 *   - SkillRegistry    -- the registry class (register, match, enable, disable)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerPattern =
  | { type: "exact"; value: string }
  | { type: "prefix"; value: string }
  | { type: "contains"; value: string }
  | { type: "regex"; pattern: string };

export type SkillHandler = (
  input: string,
  context: SkillContext
) => Promise<SkillResult> | SkillResult;

export interface SkillContext {
  /** Raw input string that triggered this skill */
  input: string;
  /** Skill name that matched */
  skillName: string;
  /** The specific trigger that matched */
  matchedTrigger: TriggerPattern;
  /** Arbitrary metadata callers can attach at match time */
  meta?: Record<string, unknown>;
}

export interface SkillResult {
  ok: boolean;
  output?: string;
  error?: string;
  /** Optional data payload - any structured result the handler produces */
  data?: unknown;
}

export interface SkillDefinition {
  /** Unique name - used as the registry key */
  name: string;
  /** Short description (for introspection / help output) */
  description: string;
  /**
   * Higher priority wins when multiple skills match.
   * Range: 0 (lowest) - 100 (highest). Default: 50.
   */
  priority?: number;
  /** Patterns that trigger this skill. First match wins within a skill. */
  triggers: TriggerPattern[];
  /** The function called when this skill is selected */
  handler: SkillHandler;
  /** Enabled by default. Can be toggled at runtime. */
  enabled?: boolean;
  /** Optional tags for filtering / grouping */
  tags?: string[];
}

export interface SkillMatch {
  skill: SkillDefinition;
  trigger: TriggerPattern;
  /** Priority at time of match (accounts for runtime overrides) */
  priority: number;
}

export interface RegistryStats {
  total: number;
  enabled: number;
  disabled: number;
  byTag: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesTrigger(input: string, trigger: TriggerPattern): boolean {
  const lower = input.toLowerCase();
  switch (trigger.type) {
    case "exact":
      return lower === trigger.value.toLowerCase();
    case "prefix":
      return lower.startsWith(trigger.value.toLowerCase());
    case "contains":
      return lower.includes(trigger.value.toLowerCase());
    case "regex": {
      try {
        return new RegExp(trigger.pattern, "i").test(input);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

const DEFAULT_PRIORITY = 50;

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  /** Runtime priority overrides - stored separately to keep definitions immutable */
  private priorityOverrides = new Map<string, number>();
  /** Runtime enable/disable state - stored separately */
  private enabledState = new Map<string, boolean>();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a skill. Throws if a skill with the same name already exists.
   * Pass replace=true to overwrite.
   */
  register(def: SkillDefinition, replace = false): this {
    if (this.skills.has(def.name) && !replace) {
      throw new Error(
        `SkillRegistry: skill "${def.name}" is already registered. Pass replace=true to overwrite.`
      );
    }
    this.skills.set(def.name, {
      priority: DEFAULT_PRIORITY,
      enabled: true,
      ...def,
    });
    return this;
  }

  /**
   * Register multiple skills at once. Rejects the entire batch if any name
   * clashes and replace is false.
   */
  registerAll(defs: SkillDefinition[], replace = false): this {
    for (const def of defs) {
      this.register(def, replace);
    }
    return this;
  }

  /** Remove a skill entirely. Returns true if it existed. */
  unregister(name: string): boolean {
    this.priorityOverrides.delete(name);
    this.enabledState.delete(name);
    return this.skills.delete(name);
  }

  // -------------------------------------------------------------------------
  // Enable / Disable
  // -------------------------------------------------------------------------

  enable(name: string): this {
    if (!this.skills.has(name)) {
      throw new Error(`SkillRegistry: skill "${name}" not found.`);
    }
    this.enabledState.set(name, true);
    return this;
  }

  disable(name: string): this {
    if (!this.skills.has(name)) {
      throw new Error(`SkillRegistry: skill "${name}" not found.`);
    }
    this.enabledState.set(name, false);
    return this;
  }

  isEnabled(name: string): boolean {
    if (this.enabledState.has(name)) {
      return this.enabledState.get(name)!;
    }
    const def = this.skills.get(name);
    return def?.enabled ?? true;
  }

  // -------------------------------------------------------------------------
  // Priority
  // -------------------------------------------------------------------------

  /** Override the priority of a skill at runtime without mutating its definition. */
  setPriority(name: string, priority: number): this {
    if (!this.skills.has(name)) {
      throw new Error(`SkillRegistry: skill "${name}" not found.`);
    }
    if (priority < 0 || priority > 100) {
      throw new RangeError(`SkillRegistry: priority must be 0-100, got ${priority}.`);
    }
    this.priorityOverrides.set(name, priority);
    return this;
  }

  private effectivePriority(name: string): number {
    if (this.priorityOverrides.has(name)) {
      return this.priorityOverrides.get(name)!;
    }
    return this.skills.get(name)?.priority ?? DEFAULT_PRIORITY;
  }

  // -------------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------------

  /**
   * Find all skills that match the input, sorted by priority descending.
   * Only enabled skills are considered.
   */
  matchAll(input: string): SkillMatch[] {
    const matches: SkillMatch[] = [];

    for (const [name, def] of this.skills) {
      if (!this.isEnabled(name)) continue;

      for (const trigger of def.triggers) {
        if (matchesTrigger(input, trigger)) {
          matches.push({
            skill: def,
            trigger,
            priority: this.effectivePriority(name),
          });
          break; // only one trigger per skill can match
        }
      }
    }

    // Stable sort: higher priority first; ties resolved by registration order
    matches.sort((a, b) => b.priority - a.priority);
    return matches;
  }

  /**
   * Return the single best-matching skill, or null if nothing matches.
   * Highest priority wins. If two skills share the same priority, the one
   * registered first wins.
   */
  match(input: string): SkillMatch | null {
    const matches = this.matchAll(input);
    return matches[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Match input and execute the winning skill's handler.
   * Returns null if no skill matched.
   */
  async run(
    input: string,
    meta?: Record<string, unknown>
  ): Promise<SkillResult | null> {
    const matched = this.match(input);
    if (!matched) return null;

    const ctx: SkillContext = {
      input,
      skillName: matched.skill.name,
      matchedTrigger: matched.trigger,
      meta,
    };

    try {
      return await matched.skill.handler(input, ctx);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run all matching skills in priority order, stopping after the first
   * successful result (ok === true).
   */
  async runFirst(
    input: string,
    meta?: Record<string, unknown>
  ): Promise<SkillResult | null> {
    const matches = this.matchAll(input);
    for (const m of matches) {
      const ctx: SkillContext = {
        input,
        skillName: m.skill.name,
        matchedTrigger: m.trigger,
        meta,
      };
      try {
        const result = await m.skill.handler(input, ctx);
        if (result.ok) return result;
      } catch {
        // continue to next skill
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(filter?: { tag?: string; enabled?: boolean }): SkillDefinition[] {
    let defs = Array.from(this.skills.values());

    if (filter?.tag !== undefined) {
      defs = defs.filter((d) => d.tags?.includes(filter.tag!));
    }

    if (filter?.enabled !== undefined) {
      const want = filter.enabled;
      defs = defs.filter((d) => this.isEnabled(d.name) === want);
    }

    return defs;
  }

  stats(): RegistryStats {
    const all = Array.from(this.skills.values());
    const byTag: Record<string, number> = {};

    for (const def of all) {
      for (const tag of def.tags ?? []) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
      }
    }

    const enabled = all.filter((d) => this.isEnabled(d.name)).length;

    return {
      total: all.length,
      enabled,
      disabled: all.length - enabled,
      byTag,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (opt-in)
// ---------------------------------------------------------------------------

let _globalRegistry: SkillRegistry | null = null;

/** Returns the process-level singleton registry. Created lazily. */
export function getSkillRegistry(): SkillRegistry {
  if (!_globalRegistry) {
    _globalRegistry = new SkillRegistry();
  }
  return _globalRegistry;
}

/** Replace the singleton (useful in tests). */
export function setSkillRegistry(registry: SkillRegistry): void {
  _globalRegistry = registry;
}
