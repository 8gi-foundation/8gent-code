/**
 * Actuator Types
 *
 * Shared interfaces for all actuator tools.
 * ActuatorResult is the universal return type — every action returns one.
 * ActuatorConfig controls safety: dryRun, confirmation gates, target allowlists.
 */

export interface ActuatorResult {
  success: boolean;
  action: string;
  target: string;
  details: string;
  timestamp: number;
  reversible: boolean;
  undoCommand?: string;
}

export interface ActuatorConfig {
  /** When true, log what would happen without executing. Default: true */
  dryRun: boolean;
  /** When true, require explicit confirmation before executing */
  requireConfirmation: boolean;
  /** Restrict actions to these targets only. Empty array = no restriction */
  allowedTargets: string[];
}

/** Create a default safe config (dryRun on, no restrictions) */
export function defaultConfig(overrides?: Partial<ActuatorConfig>): ActuatorConfig {
  return {
    dryRun: true,
    requireConfirmation: false,
    allowedTargets: [],
    ...overrides,
  };
}

/** Build a successful ActuatorResult */
export function ok(
  action: string,
  target: string,
  details: string,
  opts?: { reversible?: boolean; undoCommand?: string },
): ActuatorResult {
  return {
    success: true,
    action,
    target,
    details,
    timestamp: Date.now(),
    reversible: opts?.reversible ?? false,
    undoCommand: opts?.undoCommand,
  };
}

/** Build a failed ActuatorResult */
export function fail(action: string, target: string, details: string): ActuatorResult {
  return {
    success: false,
    action,
    target,
    details,
    timestamp: Date.now(),
    reversible: false,
  };
}

/** Check if a target is allowed by config. Returns null if OK, error string if not. */
export function checkTarget(target: string, config: ActuatorConfig): string | null {
  if (config.allowedTargets.length === 0) return null;
  if (config.allowedTargets.includes(target)) return null;
  return `Target "${target}" not in allowedTargets: [${config.allowedTargets.join(", ")}]`;
}

/** Log an actuator action to stderr */
export function log(action: string, target: string, dryRun: boolean, detail?: string): void {
  const prefix = dryRun ? "[DRY RUN]" : "[ACTUATOR]";
  const msg = detail ? `${prefix} ${action} -> ${target}: ${detail}` : `${prefix} ${action} -> ${target}`;
  console.error(msg);
}
