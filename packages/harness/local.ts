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

import type { AgentEventCallbacks } from "../eight/types";
import { DEFAULT_HARNESS, type Harness, type HarnessTask, type StatusEvent } from "./index";

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

async function defaultCreateEngine(opts: LocalEngineOptions): Promise<LocalEngine> {
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
			yield {
				...base(),
				state: "done",
				output: settled.output,
				elapsedMs,
				...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
			};
		}
	}
}
