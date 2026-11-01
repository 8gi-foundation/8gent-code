/**
 * Tool Loop Detector - Circuit breaker for agent tool loops
 *
 * Detects three patterns:
 * 1. REPEAT: same tool+args called 3+ times in a row
 * 2. PING-PONG: alternating between two tools 4+ times
 * 3. GLOBAL: more than N executed tool calls in one turn
 * 4. REFUSED: more than M refused tool calls in one turn (#3409)
 * 5. REWRITE: the same file rewritten with write_file again and again (#4537)
 *
 * A repeat of calls that all SUCCEEDED is first answered with a recoverable
 * nudge (`recoverable: true`), not a stop (#4301): a quiet success such as
 * `mkdir -p` prints nothing, and a local model re-issues it because it cannot
 * see that it worked. The stop comes only if it keeps going.
 *
 * @see https://github.com/8gi-foundation/8gent-code/issues/975
 */

import { resolve as resolvePath } from "node:path";

export type LoopType = "repeat" | "ping-pong" | "global" | "refused" | "rewrite";

/** Tools that change a file. A write to another path through any of them ends a rewrite streak. */
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "multi_edit"]);

/**
 * Default writes to one path before the rewrite guard speaks (#4537). Override with
 * EIGHT_WRITE_LOOP_MAX; a value that is not an integer of 2 or more falls back to the default.
 */
export const DEFAULT_WRITE_LOOP_MAX = 4;

export function writeLoopMaxFromEnv(env: Record<string, string | undefined> = process.env): number {
	const raw = (env.EIGHT_WRITE_LOOP_MAX ?? "").trim();
	if (raw === "") return DEFAULT_WRITE_LOOP_MAX;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 2 ? n : DEFAULT_WRITE_LOOP_MAX;
}

/** Read-only tools whose clean result may be nudged rather than stopped on repeat. */
const READ_ONLY_NUDGEABLE = new Set(["read_file", "list_files"]);

/**
 * Positive signal for the success-repeat nudge (#4301). True only for:
 *  - a `run_command` whose result is a clean silent success: empty, or the
 *    "Command completed successfully." note (with its optional follow-on
 *    sentences), with no "Exit code" and no "TIMEOUT";
 *  - a plain read-only tool (read_file, list_files) with a non-error result.
 * Everything else (writes, POSTs, commits, any command with output, any
 * failure or timeout) is false and keeps the stop at 3.
 */
export function isQuietSuccess(toolName: string, resultText: string): boolean {
	const text = (resultText ?? "").trim();
	if (toolName === "run_command") {
		if (/^Exit code\b|^TIMEOUT after\b/m.test(text)) return false;
		return text === "" || text.startsWith("Command completed successfully.");
	}
	if (READ_ONLY_NUDGEABLE.has(toolName)) return !isErrorToolResult(text);
	return false;
}

export interface LoopDetection {
	detected: true;
	type: LoopType;
	/** For the logs and the model: what tripped, in the detector's terms. */
	message: string;
	/** For the person: why the turn stopped, in plain words (#3409). */
	userMessage: string;
	/**
	 * True when the caller should tell the model and let the turn continue
	 * instead of stopping it (#4301). Only ever set for a repeat of successful
	 * calls, below the stop ceiling.
	 */
	recoverable?: boolean;
}

interface ToolCall {
	toolName: string;
	argsHash: string;
	/** Known to have run and succeeded. Unknown or failed is never true. */
	succeeded: boolean;
}

/** Per-file write counts for one turn, keyed by resolved absolute path. */
interface WriteStreak {
	path: string;
	/** write_file calls to this file this turn, since an edit_file or patch of it. */
	writes: number;
	/** Writes to this file with no check, read or other non-writing call since the previous one. */
	unchecked: number;
	/** Writes whose content equalled the previous write to the same file. */
	identical: number;
	lastContent: string | null;
	/** The latest write had the same content as the write before it. */
	lastIdentical: boolean;
}

export interface ToolLoopDetectorConfig {
	/** Number of recent calls to track (default 20) */
	windowSize?: number;
	/** Consecutive identical calls to trigger repeat detection (default 3) */
	repeatThreshold?: number;
	/** Alternating pair count to trigger ping-pong detection (default 4) */
	pingPongThreshold?: number;
	/** Max executed tool calls per turn before global limit fires (default 50) */
	globalLimit?: number;
	/** Max refused tool calls per turn before the refused limit fires (default 100) */
	refusedLimit?: number;
	/** Writes to one path before the rewrite guard nudges (default 4, env EIGHT_WRITE_LOOP_MAX) */
	writeLoopMax?: number;
	/** Base for relative write paths (default process.cwd()) */
	workingDirectory?: string;
}

export class ToolLoopDetector {
	private history: ToolCall[] = [];
	private totalCalls = 0;
	private refusedCalls = 0;
	private windowSize: number;
	private repeatThreshold: number;
	private pingPongThreshold: number;
	private globalLimit: number;
	private refusedLimit: number;
	/** Extra identical successful calls tolerated, each nudged, before the stop. */
	private successRepeatGrace = 2;
	private writeLoopMax: number;
	private streaks = new Map<string, WriteStreak>();
	/** The file the most recent call wrote, or null when it was anything else. */
	private lastWritten: WriteStreak | null = null;
	private workingDirectory: string;

	constructor(config: ToolLoopDetectorConfig = {}) {
		this.windowSize = config.windowSize ?? 20;
		this.repeatThreshold = config.repeatThreshold ?? 3;
		this.pingPongThreshold = config.pingPongThreshold ?? 4;
		this.globalLimit = config.globalLimit ?? 50;
		this.refusedLimit = config.refusedLimit ?? 100;
		this.writeLoopMax = config.writeLoopMax ?? writeLoopMaxFromEnv();
		this.workingDirectory = config.workingDirectory ?? process.cwd();
	}

	/** Track write_file calls per file, so ./a.js, a.js and /abs/a.js are one file (#4537). */
	private trackWrite(toolName: string, args: Record<string, unknown>, refused: boolean): void {
		if (refused) {
			this.lastWritten = null;
			return;
		}
		const raw =
			typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
					? args.file_path
					: null;
		const path = raw === null || raw === "" ? null : resolvePath(this.workingDirectory, raw);
		if (toolName === "write_file" && path !== null) {
			const content = typeof args.content === "string" ? args.content : null;
			let s = this.streaks.get(path);
			if (!s) {
				s = {
					path: raw as string,
					writes: 0,
					unchecked: 0,
					identical: 0,
					lastContent: null,
					lastIdentical: false,
				};
				this.streaks.set(path, s);
			}
			s.writes++;
			s.unchecked++;
			s.lastIdentical = content !== null && content === s.lastContent;
			if (s.lastIdentical) s.identical++;
			s.lastContent = content;
			this.lastWritten = s;
			return;
		}
		this.lastWritten = null;
		if (MUTATING_TOOLS.has(toolName)) {
			// A targeted edit is the normal fix cadence: it clears that file's count.
			if (path !== null) this.streaks.delete(path);
			return;
		}
		// A check, read or any other call: later writes are no longer back to back.
		for (const s of this.streaks.values()) s.unchecked = 0;
	}

	private checkRewrite(): LoopDetection | null {
		const s = this.lastWritten;
		const max = this.writeLoopMax;
		if (!s || s.writes < 2) return null;
		// Writes with nothing between them trip at max; writes with checks between them
		// at 2 * max, so a normal write, run, fix, run cadence is left alone.
		const strict = s.unchecked >= max;
		const spaced = s.writes >= max * 2;
		const sameContent = s.lastIdentical;
		if (!strict && !spaced && !sameContent) return null;
		const stop = s.unchecked >= max + 2 || s.writes >= max * 2 + 2 || s.identical >= max;
		const userMessage = `I rewrote ${s.path} ${s.writes} times without finishing, so I stopped to avoid a loop.`;
		if (stop) {
			return {
				detected: true,
				type: "rewrite",
				message: `Rewrite loop detected: "${s.path}" was written ${s.writes} times this turn. Stopping the turn.`,
				userMessage,
			};
		}
		return {
			detected: true,
			type: "rewrite",
			recoverable: true,
			message: sameContent
				? `${s.path} is unchanged: this write has the same content as the last one. Run your checks on it or finish with a reply; do not write it again.`
				: `${s.path} has now been written ${s.writes} times this turn. Run your checks on it or finish with a reply, and change it only for a failure you can name.`,
			userMessage,
		};
	}

	/**
	 * Record a tool call. Call this every time a tool is called.
	 *
	 * A call the harness refused before it ran (`refused: true`) still counts
	 * for the repeat and ping-pong checks, since the same refused call over and
	 * over is a loop. It does not count toward the global limit: that limit
	 * guards against runaway EXECUTION, and a refused call executed nothing.
	 * Counting refusals ended real tasks one step short (#3409: 51 calls, 7 of
	 * them refused chaining, the 51st was the git_add before the commit).
	 * Refusals have their own, looser ceiling (refusedLimit) instead.
	 *
	 * The caller must decide `refused` from the call itself, never from the
	 * tool's output text: output can say anything, including "[BLOCKED]".
	 */
	record(
		toolName: string,
		args: Record<string, unknown>,
		opts: { refused?: boolean; succeeded?: boolean } = {},
	): void {
		const argsHash = JSON.stringify(args);
		this.history.push({
			toolName,
			argsHash,
			succeeded: opts.succeeded === true && !opts.refused,
		});
		if (opts.refused) this.refusedCalls++;
		else this.totalCalls++;
		this.trackWrite(toolName, args, opts.refused === true);

		// Keep only the last N entries
		if (this.history.length > this.windowSize) {
			this.history.shift();
		}
	}

	/**
	 * Check for loop patterns. Returns detection info or null if no loop found.
	 */
	check(): LoopDetection | null {
		// 1. GLOBAL: too many total calls this turn
		if (this.totalCalls > this.globalLimit) {
			return {
				detected: true,
				type: "global",
				message: `Global tool call limit exceeded: ${this.totalCalls} executed calls this turn (limit: ${this.globalLimit}). Aborting to prevent runaway execution.`,
				userMessage: `I reached the limit of ${this.globalLimit} tool calls in one turn.`,
			};
		}

		// 1b. REFUSED: too many refused calls this turn (#3409)
		if (this.refusedCalls > this.refusedLimit) {
			return {
				detected: true,
				type: "refused",
				message: `Refused tool call limit exceeded: ${this.refusedCalls} refused calls this turn (limit: ${this.refusedLimit}). Aborting to prevent a refusal loop.`,
				userMessage: `${this.refusedCalls} of my tool calls this turn were refused, past the limit of ${this.refusedLimit}.`,
			};
		}

		const len = this.history.length;

		// 2. REPEAT: same tool+args N times in a row
		if (len >= this.repeatThreshold) {
			const last = this.history[len - 1];
			let streak = 1;
			for (let i = len - 2; i >= 0; i--) {
				const entry = this.history[i];
				if (entry.toolName === last.toolName && entry.argsHash === last.argsHash) {
					streak++;
				} else {
					break;
				}
			}
			if (streak >= this.repeatThreshold) {
				// Identical calls that all succeeded are a model that cannot see its
				// own success, not a stuck one: nudge first, stop only past the ceiling.
				const allSucceeded = this.history.slice(len - streak).every((e) => e.succeeded);
				if (allSucceeded && streak < this.repeatThreshold + this.successRepeatGrace) {
					return {
						detected: true,
						type: "repeat",
						recoverable: true,
						message: `"${last.toolName}" has now succeeded ${streak} times in a row with identical arguments. It already worked and repeating it changes nothing. Continue with the next step of the task.`,
						userMessage: `I repeated a ${last.toolName} call that had already worked.`,
					};
				}
				return {
					detected: true,
					type: "repeat",
					message: `Repeat loop detected: "${last.toolName}" called ${streak} times in a row with identical arguments. Try a different approach.`,
					userMessage: `I made the same ${last.toolName} call ${streak} times in a row, so I stopped to avoid a loop.`,
				};
			}
		}

		// 2b. REWRITE: the same file written again and again (#4537)
		const rewrite = this.checkRewrite();
		if (rewrite) return rewrite;

		// 3. PING-PONG: alternating between two tools
		// Need at least pingPongThreshold * 2 entries to detect
		const minEntries = this.pingPongThreshold * 2;
		if (len >= minEntries) {
			const a = this.history[len - 2];
			const b = this.history[len - 1];

			// Only check if the last two are different tools
			if (a.toolName !== b.toolName) {
				let alternations = 1; // We already have one pair (a, b)
				for (let i = len - 3; i >= 0; i -= 2) {
					const prev = this.history[i];
					const prevNext = this.history[i + 1];
					if (
						prev &&
						prevNext &&
						prev.toolName === a.toolName &&
						prevNext.toolName === b.toolName
					) {
						alternations++;
					} else {
						break;
					}
				}
				if (alternations >= this.pingPongThreshold) {
					return {
						detected: true,
						type: "ping-pong",
						message: `Ping-pong loop detected: alternating between "${a.toolName}" and "${b.toolName}" ${alternations} times. Break the cycle and try a different strategy.`,
						userMessage: `I went back and forth between ${a.toolName} and ${b.toolName} ${alternations} times, so I stopped to avoid a loop.`,
					};
				}
			}
		}

		return null;
	}

	/**
	 * Reset state. Call at the start of each new turn/message.
	 */
	reset(): void {
		this.history = [];
		this.totalCalls = 0;
		this.refusedCalls = 0;
		this.streaks.clear();
		this.lastWritten = null;
	}
}

// ---------------------------------------------------------------------------
// DoomLoopDetector: period 1 to 4 cycle detection on a sliding 12-call window
// with normalized JSON-arg signatures. See issue #2461.
//
// Event surface (RFC #2527 Option A, James 2026-05-10):
//   detector.on("stuck", (event: DoomStuckEvent) => { ... })
// fires immediately when a cycle is detected. Mirrors the existing `check()`
// return value but lets consumers like @8gent/handeyes subscribe once at
// startup instead of polling. `check()` still returns the boolean for
// backward compat with the agent loop's existing usage.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { isErrorToolResult } from "./honesty";

export interface DoomToolCall {
	toolName: string;
	args: unknown;
}

export interface DoomLoopDetectorConfig {
	/** Sliding window length (default 12). */
	windowSize?: number;
	/** Max period to scan (default 4). */
	maxPeriod?: number;
}

/**
 * Payload emitted on the "stuck" event when DoomLoopDetector detects a
 * repeating cycle in the tool stream.
 */
export interface DoomStuckEvent {
	/** Cycle period detected (1..maxPeriod). */
	period: number;
	/** How many full repetitions were observed at the tail (3 for period-1, 2 otherwise). */
	reps: number;
	/** Sliding-window length at the moment of detection. */
	windowSize: number;
	/** Epoch ms when the cycle was detected. */
	detectedAt: number;
	/** The repeating tail signatures (length = period * reps). */
	signatures: string[];
}

/**
 * Strongly-typed event names. Add new events here as they ship.
 */
export interface DoomLoopDetectorEvents {
	stuck: (event: DoomStuckEvent) => void;
}

/**
 * Stable JSON serializer with deterministic key order. Used to canonicalize
 * tool-call args so cosmetic differences (key order, whitespace) do not
 * register as distinct signatures.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function normalizeArgs(args: unknown): string {
	if (args === undefined) return "";
	if (typeof args === "string") {
		// If it parses as JSON, normalize; otherwise use raw string.
		try {
			return stableStringify(JSON.parse(args));
		} catch {
			return JSON.stringify(args);
		}
	}
	return stableStringify(args);
}

function signature(call: DoomToolCall): string {
	return `${call.toolName}:${normalizeArgs(call.args)}`;
}

/**
 * Detects repeating cycles in a stream of tool calls. Build the signature
 * stream, truncate to the sliding window, then scan periods 1..maxPeriod for
 * a tail that repeats `reps` times (reps = 3 for period 1, else 2).
 *
 * Extends EventEmitter so consumers can subscribe to the "stuck" event for
 * push-style notification on detection. The classic `check(): boolean` API
 * is preserved unchanged for existing callers.
 */
export class DoomLoopDetector extends EventEmitter {
	private history: string[] = [];
	private readonly windowSize: number;
	private readonly maxPeriod: number;

	constructor(config: DoomLoopDetectorConfig = {}) {
		super();
		this.windowSize = config.windowSize ?? 12;
		this.maxPeriod = config.maxPeriod ?? 4;
	}

	reset(): void {
		this.history = [];
	}

	// Typed overloads for `on` so handeyes (and any future consumer) gets
	// inferred event-payload types without `as any`.
	on<E extends keyof DoomLoopDetectorEvents>(event: E, listener: DoomLoopDetectorEvents[E]): this;
	on(event: string | symbol, listener: (...args: unknown[]) => void): this;
	on(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	once<E extends keyof DoomLoopDetectorEvents>(event: E, listener: DoomLoopDetectorEvents[E]): this;
	once(event: string | symbol, listener: (...args: unknown[]) => void): this;
	once(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.once(event, listener);
	}

	off<E extends keyof DoomLoopDetectorEvents>(event: E, listener: DoomLoopDetectorEvents[E]): this;
	off(event: string | symbol, listener: (...args: unknown[]) => void): this;
	off(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(event, listener);
	}

	/**
	 * Append `calls` to history (truncating to windowSize) and return true
	 * if a period-1..maxPeriod cycle is detected at the tail. Also emits
	 * a "stuck" event with full payload when a cycle is detected.
	 */
	check(calls: DoomToolCall[]): boolean {
		for (const c of calls) {
			this.history.push(signature(c));
		}
		if (this.history.length > this.windowSize) {
			this.history = this.history.slice(this.history.length - this.windowSize);
		}

		const hist = this.history;
		const len = hist.length;

		for (let period = 1; period <= this.maxPeriod; period++) {
			const reps = period === 1 ? 3 : 2;
			const needed = period * reps;
			if (len < needed) continue;

			const tail = hist.slice(len - needed);
			let isCycle = true;
			for (let i = 0; i < needed; i++) {
				if (tail[i] !== tail[i % period]) {
					isCycle = false;
					break;
				}
			}
			if (isCycle) {
				const event: DoomStuckEvent = {
					period,
					reps,
					windowSize: this.windowSize,
					detectedAt: Date.now(),
					signatures: tail,
				};
				this.emit("stuck", event);
				return true;
			}
		}
		return false;
	}
}
