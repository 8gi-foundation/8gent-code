// 8gent-hands - shared types for the v0 wrapper around cua-driver.
//
// The Swift app (apps/8gent-computer) shells out to `bun run packages/hands/run.ts`
// and parses the JSON written to stdout. Keep this surface stable so the Swift
// side can decode without ceremony.

export interface PlannedStep {
  /** Tool name as exposed by `cua-driver list-tools`, e.g. "screenshot". */
  tool: string;
  /** JSON args matching the tool's inputSchema. May be empty. */
  args: Record<string, unknown>;
  /** Why the planner picked this step (one short sentence). */
  rationale?: string;
}

export interface StepResult {
  step: PlannedStep;
  ok: boolean;
  /** Stdout text from cua-driver, trimmed. */
  output?: string;
  /** Path on disk to the screenshot if the tool produced one. */
  imagePath?: string;
  /** Stderr text or wrapper-level error message. */
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface RunResult {
  /** The original natural-language prompt the user typed. */
  prompt: string;
  /** Which planner produced the step list. */
  plannerMode: "llm" | "stub";
  /** Identity of the LLM if plannerMode === "llm". */
  plannerModel?: string;
  /** Plan returned before any execution. */
  plan: PlannedStep[];
  /** Execution results in order. */
  results: StepResult[];
  /** Overall success - every step's `ok` was true. */
  ok: boolean;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** Total wall-clock duration in ms. */
  durationMs: number;
}

/** Hardcoded vocabulary the stub planner understands. */
export const STUB_TOOLS = [
  "screenshot",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "check_permissions",
] as const;
