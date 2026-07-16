/**
 * Meta-harness foundation (part of #2797).
 *
 * The pluggable seam that lets 8gent dispatch work through interchangeable
 * agent backends ("harnesses"). Mirrors the provider registry pattern used
 * for models: local-first default (8gent-local), everything else opt-in.
 *
 * Clean-room: concepts observed in herdr (AGPL) re-derived from scratch,
 * zero code copied. See packages/harness/SPEC.md for the full contract.
 */

import { LocalHarness } from "./local";

/** Lifecycle states a harness task can report. */
export type HarnessState = "queued" | "working" | "blocked" | "needs_input" | "done" | "error";

/**
 * One observable moment in a harness task's life.
 *
 * Honesty rules: `tool`, `tokens`, and `elapsedMs` are only present when the
 * underlying agent loop actually reported them. Never fabricated.
 */
export interface StatusEvent {
	/** The task id this event belongs to. */
	agentId: string;
	/** Registered harness name, e.g. "8gent-local". */
	harness: string;
	state: HarnessState;
	/** Tool name, present on real tool-call activity. */
	tool?: string;
	/** Cumulative real token usage from the agent loop's step events. */
	tokens?: number;
	/** Wall-clock milliseconds since the run started. */
	elapsedMs?: number;
	/** Final response text (done) or error message (error). */
	output?: string;
	/** Date.now() when the event was created. */
	ts: number;
}

/** A unit of work dispatched through a harness. */
export interface HarnessTask {
	id: string;
	prompt: string;
	cwd?: string;
}

/**
 * An agent backend. `run` streams StatusEvents: `queued` first, `working`
 * events while executing, terminated by exactly one `done` or `error`.
 */
export interface Harness {
	name: string;
	run(task: HarnessTask): AsyncIterable<StatusEvent>;
}

/** The local-first default backend. */
export const DEFAULT_HARNESS = "8gent-local";

/**
 * Registry of pluggable harnesses. Same shape as the model provider registry:
 * the local backend is the default, external adapters register opt-in.
 */
export class HarnessRegistry {
	private harnesses = new Map<string, Harness>();

	register(h: Harness): void {
		if (this.harnesses.has(h.name)) {
			throw new Error(`harness already registered: ${h.name}`);
		}
		this.harnesses.set(h.name, h);
	}

	/** Resolve a harness by name. No name = DEFAULT_HARNESS. Throws if unknown. */
	get(name: string = DEFAULT_HARNESS): Harness {
		const h = this.harnesses.get(name);
		if (!h) {
			throw new Error(`unknown harness: ${name} (registered: ${this.list().join(", ") || "none"})`);
		}
		return h;
	}

	/** Registered harness names in registration order. */
	list(): string[] {
		return [...this.harnesses.keys()];
	}
}

/** A registry with the 8gent-local default backend pre-registered. */
export function createDefaultRegistry(): HarnessRegistry {
	const registry = new HarnessRegistry();
	registry.register(new LocalHarness());
	return registry;
}

export { LocalHarness } from "./local";
export { HarnessRunner } from "./runner";
export {
	CLI_HARNESS_ENV,
	CliHarness,
	type CliHarnessConfig,
	parseCliHarnessConfigs,
	registerCliHarnessesFromEnv,
} from "./adapters/cli";
