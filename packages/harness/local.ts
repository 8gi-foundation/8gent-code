/**
 * LocalHarness - the "8gent-local" default backend (part of #2797).
 *
 * Wraps the existing packages/eight Agent so a task dispatched through the
 * Harness interface executes on the real local agent loop. Every StatusEvent
 * field traces to a genuine signal (AgentEventCallbacks / wall clock / the
 * actual response). Nothing is fabricated.
 *
 * The Agent class is resolved lazily so importing this module stays cheap and
 * side-effect free; the heavy agent graph loads only when a run actually
 * needs the default engine.
 */

import os from "node:os";
import path from "node:path";
import type { AgentEventCallbacks } from "../eight/types";
import { DEFAULT_HARNESS, type Harness, type HarnessTask, type StatusEvent } from "./index";
import { sanitizeFinalOutput } from "./sanitize";

/** The minimal engine surface LocalHarness drives. The real Agent satisfies it. */
export interface LocalEngine {
	chat(prompt: string): Promise<string>;
}

export interface LocalEngineOptions {
	cwd?: string;
	/** Bridge: the engine reports real activity through these callbacks. */
	events: AgentEventCallbacks;
}

export interface LocalHarnessOptions {
	/**
	 * Engine factory seam (tests, future reuse). Default: the real
	 * packages/eight Agent on the daemon's local defaults
	 * (EIGHGENT_MODEL || "eight:latest", runtime "ollama").
	 */
	createEngine?: (opts: LocalEngineOptions) => LocalEngine | Promise<LocalEngine>;
}

/** Exposed for tests: proves the default factory targets the real Agent class. */
export async function defaultEngineFactoryTarget(): Promise<unknown> {
	const { Agent } = await import("../eight/agent");
	return Agent;
}

/**
 * #2803 guard: a test or dogfood run must NEVER point the real Agent at the
 * machine-wide global data store (~/.8gent) - that is where every real 8gent
 * product's memory lives, and a hallucinated `remember` call from a test run
 * would permanently corrupt it. Under NODE_ENV=test (what `bun test` sets),
 * BUN_TEST, or an explicit EIGHT_HARNESS_DOGFOOD flag, the default engine
 * factory refuses to construct the real Agent unless EIGHT_DATA_DIR points at
 * an isolated directory OUTSIDE the global store. Production runs (no test
 * env) are untouched: the real Agent keeps its real store.
 */
export function assertIsolatedDataDir(
	env: Record<string, string | undefined> = process.env,
): void {
	const isTestOrDogfood =
		env.NODE_ENV === "test" || env.BUN_TEST === "1" || !!env.EIGHT_HARNESS_DOGFOOD;
	if (!isTestOrDogfood) return;

	const globalBase = path.resolve(path.join(os.homedir(), ".8gent"));
	const dataDir = env.EIGHT_DATA_DIR;
	if (!dataDir) {
		throw new Error(
			"test/dogfood run without EIGHT_DATA_DIR: refusing to run the real Agent " +
				"against the global ~/.8gent store. Set EIGHT_DATA_DIR to an isolated " +
				"temporary directory first (#2803).",
		);
	}
	const resolved = path.resolve(dataDir);
	if (resolved === globalBase || resolved.startsWith(globalBase + path.sep)) {
		throw new Error(
			`EIGHT_DATA_DIR (${resolved}) is inside the real global store (${globalBase}): ` +
				"test/dogfood runs must use an isolated temporary directory (#2803).",
		);
	}
}

async function defaultCreateEngine(opts: LocalEngineOptions): Promise<LocalEngine> {
	assertIsolatedDataDir();
	const { Agent } = await import("../eight/agent");
	return new Agent({
		model: process.env.EIGHGENT_MODEL || "eight:latest",
		runtime: "ollama",
		workingDirectory: opts.cwd || process.cwd(),
		events: opts.events,
	});
}

export class LocalHarness implements Harness {
	readonly name = DEFAULT_HARNESS;
	private createEngine: NonNullable<LocalHarnessOptions["createEngine"]>;

	constructor(options: LocalHarnessOptions = {}) {
		this.createEngine = options.createEngine ?? defaultCreateEngine;
	}

	async *run(task: HarnessTask): AsyncIterable<StatusEvent> {
		const startedAt = Date.now();
		let totalTokens: number | undefined;

		const base = (): Pick<StatusEvent, "agentId" | "harness" | "ts"> => ({
			agentId: task.id,
			harness: this.name,
			ts: Date.now(),
		});

		// #2803: an empty/whitespace prompt must never reach the engine. A local
		// model given no input can hallucinate "facts" and call memory tools,
		// permanently corrupting the real global store. Reject before any engine
		// exists - a single honest error event, no queued, no engine, no side
		// effects. Guarded here (not only in the HTTP layer) so EVERY caller of
		// the Harness interface is covered.
		if (!task.prompt || !task.prompt.trim()) {
			yield {
				...base(),
				state: "error",
				output: "empty prompt rejected: a harness task requires a non-empty prompt (#2803)",
			};
			return;
		}

		yield { ...base(), state: "queued" };

		// Bridge push-style agent callbacks into this pull-style generator.
		const pending: StatusEvent[] = [];
		let wake: (() => void) | null = null;
		const push = (e: StatusEvent) => {
			pending.push(e);
			wake?.();
			wake = null;
		};

		const events: AgentEventCallbacks = {
			onToolStart: (e) => {
				push({
					...base(),
					state: "working",
					tool: e.toolName,
					elapsedMs: Date.now() - startedAt,
				});
			},
			onStepFinish: (e) => {
				totalTokens = (totalTokens ?? 0) + e.usage.totalTokens;
				push({
					...base(),
					state: "working",
					tokens: totalTokens,
					elapsedMs: Date.now() - startedAt,
				});
			},
		};

		yield { ...base(), state: "working", elapsedMs: Date.now() - startedAt };

		const engine = await this.createEngine({ cwd: task.cwd, events });
		const chat = engine.chat(task.prompt);
		// Terminal marker: null on success carries the output separately below.
		let outcome: { output: string } | { error: string } | null = null;
		chat.then(
			(output) => {
				outcome = { output };
				wake?.();
				wake = null;
			},
			(err: unknown) => {
				outcome = { error: err instanceof Error ? err.message : String(err) };
				wake?.();
				wake = null;
			},
		);

		// Drain callback events until the chat settles, then emit the terminal event.
		while (true) {
			while (pending.length > 0) {
				const next = pending.shift();
				if (next) yield next;
			}
			if (outcome !== null) break;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
		// Flush anything that raced in with the settlement.
		while (pending.length > 0) {
			const next = pending.shift();
			if (next) yield next;
		}

		const elapsedMs = Date.now() - startedAt;
		const settled = outcome as { output: string } | { error: string };
		if ("error" in settled) {
			yield { ...base(), state: "error", output: settled.error, elapsedMs };
		} else {
			// #2804: never let unexecuted tool_call protocol syntax surface as a
			// "done" answer. Strip it; if nothing remains, the turn failed.
			const { text, strippedToolCall } = sanitizeFinalOutput(settled.output);
			if (strippedToolCall && !text) {
				yield {
					...base(),
					state: "error",
					output:
						"the model emitted an unexecuted tool_call block instead of an answer; " +
						"raw protocol output withheld from done (#2804)",
					elapsedMs,
				};
			} else {
				yield {
					...base(),
					state: "done",
					output: text,
					elapsedMs,
					...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
				};
			}
		}
	}
}
