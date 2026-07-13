/**
 * TraceCapture - Step 1 of the usage-signal RL pipeline (#2752).
 *
 * Captures tool-call trajectories from real agent sessions and turns the
 * successful ones into training material. Three hard guarantees:
 *
 *   - Opt-in: OFF by default. Only `training_proxy.traceCapture: true` in
 *     .8gent/config.json enables it. When off, every method is a no-op.
 *   - Local only: trajectories are appended to
 *     .8gent/kernel/traces/trajectories.jsonl. This module has no network path.
 *   - PII-scrubbed at capture: redact() (secrets) then anonymize() (PII) run
 *     on every field BEFORE any byte hits disk. If anything secret-shaped or
 *     PII-shaped survives both passes, the whole trajectory is dropped.
 *     Fail closed: no partial writes, no raw fallback.
 *
 * The full trajectory (prompt, ordered tool steps, response) is preserved in
 * the JSONL for future trajectory-aware training formats; `toTrainingPair`
 * adapts a fully successful trajectory into the existing TrainingPair shape
 * consumed by PersonalCollector and the GRPO pair adapter.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redact } from "../memory/redact";
import { containsSecret } from "../permissions/goal-secret-scrub";
import { anonymize, containsPii } from "../permissions/pii-anonymizer";
import type { TrainingPair } from "./personal-collector";

/** One tool invocation inside a turn, in execution order. */
export interface ToolStep {
	/** Tool name, e.g. "edit_file" */
	tool: string;
	/** Compact JSON summary of the arguments (scrubbed before storage) */
	argsSummary: string;
	/** Whether the tool call succeeded */
	ok: boolean;
	/** Wall time of the call, when known */
	durationMs?: number;
}

/** A captured, scrubbed tool-call trajectory for one agent turn. */
export interface Trajectory {
	sessionId: string;
	turnIndex: number;
	model: string;
	/** Scrubbed user prompt */
	prompt: string;
	/** Scrubbed final response */
	response: string;
	/** Ordered, scrubbed tool steps executed during the turn */
	toolSteps: ToolStep[];
	/** True when every tool step in the turn succeeded */
	allToolsSucceeded: boolean;
	/** Judge score for the turn (0.0-1.0) */
	score: number;
	/** Capture timestamp (epoch ms) */
	capturedAt: number;
}

export interface FinalizeTurnInput {
	sessionId: string;
	turnIndex: number;
	model: string;
	prompt: string;
	response: string;
	score: number;
}

/** Hard cap on buffered steps per turn so a runaway loop cannot grow memory. */
const MAX_BUFFERED_STEPS = 200;

/**
 * Scrub a single text field: redact secrets, then anonymize PII.
 * Returns null when something secret- or PII-shaped survives both passes,
 * meaning the caller must drop the whole trajectory.
 */
function scrubField(text: string): string | null {
	const safe = anonymize(redact(text)).text;
	if (containsSecret(safe) || containsPii(safe)) return null;
	return safe;
}

export class TraceCapture {
	private tracesDir: string;
	private trajectoriesPath: string;
	private optedIn: boolean;
	private buffer: ToolStep[] = [];

	constructor(projectRoot: string = process.cwd(), enabled = false) {
		this.tracesDir = resolve(projectRoot, ".8gent", "kernel", "traces");
		this.trajectoriesPath = join(this.tracesDir, "trajectories.jsonl");
		this.optedIn = enabled;
	}

	/** Whether trace capture is opted in. */
	get enabled(): boolean {
		return this.optedIn;
	}

	/**
	 * Buffer one tool step for the current turn. No-op unless opted in.
	 * Raw args stay in memory only; scrubbing happens at finalize, before
	 * anything is written.
	 */
	recordToolStep(step: ToolStep): void {
		if (!this.optedIn) return;
		if (this.buffer.length >= MAX_BUFFERED_STEPS) return;
		this.buffer.push(step);
	}

	/**
	 * Close out the current turn: scrub every field, persist the trajectory
	 * locally, and return it. Returns null (writing nothing) when capture is
	 * off or when a secret/PII survives scrubbing. Always clears the step
	 * buffer so turns never bleed into each other.
	 */
	finalizeTurn(input: FinalizeTurnInput): Trajectory | null {
		const steps = this.buffer;
		this.buffer = [];

		if (!this.optedIn) return null;

		const prompt = scrubField(input.prompt);
		const response = scrubField(input.response);
		if (prompt === null || response === null) return null;

		const toolSteps: ToolStep[] = [];
		for (const step of steps) {
			const argsSummary = scrubField(step.argsSummary);
			if (argsSummary === null) return null; // fail closed on any step
			toolSteps.push({ ...step, argsSummary });
		}

		const trajectory: Trajectory = {
			sessionId: input.sessionId,
			turnIndex: input.turnIndex,
			model: input.model,
			prompt,
			response,
			toolSteps,
			allToolsSucceeded: toolSteps.every((s) => s.ok),
			score: input.score,
			capturedAt: Date.now(),
		};

		this.ensureDir();
		appendFileSync(this.trajectoriesPath, `${JSON.stringify(trajectory)}\n`);

		return trajectory;
	}

	/**
	 * Adapt a captured trajectory into the TrainingPair shape consumed by
	 * PersonalCollector / the GRPO pair adapter. Only fully successful
	 * trajectories qualify; anything else returns null.
	 */
	toTrainingPair(trajectory: Trajectory, userId: string): Omit<TrainingPair, "collectedAt"> | null {
		if (!trajectory.allToolsSucceeded) return null;

		return {
			userId,
			sessionId: trajectory.sessionId,
			prompt: trajectory.prompt,
			response: trajectory.response,
			score: trajectory.score,
			model: trajectory.model,
			toolCallsSucceeded: true,
			userCorrected: false,
		};
	}

	/** Read all captured trajectories back from local storage. */
	readTrajectories(): Trajectory[] {
		if (!existsSync(this.trajectoriesPath)) return [];

		return readFileSync(this.trajectoriesPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as Trajectory;
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Trajectory[];
	}

	private ensureDir(): void {
		if (!existsSync(this.tracesDir)) {
			mkdirSync(this.tracesDir, { recursive: true });
		}
	}
}
