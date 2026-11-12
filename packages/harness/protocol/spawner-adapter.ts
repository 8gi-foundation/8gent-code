/**
 * HarnessAdapter over the existing process path, spawnCLIAgent in
 * packages/orchestration/universal-spawner.ts. Each turn is one child
 * process: stdout streams as text.delta, stderr as log, the exit code
 * decides the status. Nothing carries between turns, so `sessions` is false.
 *
 * Every turn passes a gate before anything is spawned. The default gate is
 * the one spawn_agent uses for a process child: the depth cap, the shell
 * sanitiser and System One for a shell turn; the hosted opt-in
 * (EIGHT_ALLOW_HOSTED=1) for any runtime that is not the shell.
 */

import { killProcessTree } from "../../core/shell";
import type { AgentRuntime, RunningCLIAgent } from "../../orchestration/universal-spawner";
import {
	HARNESS_PROTOCOL_VERSION,
	type HarnessAdapter,
	type HarnessCapabilities,
	HarnessError,
	type HarnessSession,
	type HarnessTurn,
	type StartOptions,
	type TurnInput,
	TurnLog,
	harnessProtocolEnabled,
} from "./types";

/** Runtimes the process path runs. The in-process runtime belongs to AgentPool. */
export type ProcessRuntime = Exclude<AgentRuntime, "8gent">;

/** Null to run the turn, otherwise the reason it was refused. */
export type TurnGate = (
	text: string,
	ctx: { runtime: ProcessRuntime; cwd: string },
) => Promise<string | null>;

type Spawn = (
	runtime: ProcessRuntime,
	task: string,
	options: { workingDirectory?: string; timeout?: number; env?: Record<string, string> },
) => RunningCLIAgent;

export interface SpawnerHarnessOptions {
	runtime: ProcessRuntime;
	/** Defaults to defaultTurnGate. */
	gate?: TurnGate;
	/** Defaults to spawnCLIAgent. A seam for tests and for later runtimes. */
	spawn?: Spawn;
	/** How long to wait for pipes to drain once the process has exited. Default 250ms. */
	drainMs?: number;
}

/** The checks spawn_agent applies to a process child, in the same order. */
export const defaultTurnGate: TurnGate = async (text, { runtime, cwd }) => {
	const { agentDepthRefusal } = await import("../../orchestration/index");
	const depth = agentDepthRefusal();
	if (depth) return depth;
	if (runtime !== "shell") {
		const { hostedAllowed } = await import("../../providers/failover");
		if (!hostedAllowed()) {
			return `Not started: runtime "${runtime}" sends the turn to a hosted model, and hosted providers are off unless EIGHT_ALLOW_HOSTED=1.`;
		}
		return null;
	}
	const { sanitizeShellCommand } = await import("../../permissions/shell-sanitizer");
	const validation = sanitizeShellCommand(text);
	if (!validation.safe) return `[BLOCKED] ${validation.reason}`;
	const { systemOneGate } = await import("../../permissions/system-one-gate");
	const verdict = await systemOneGate(text, process.env, cwd);
	return verdict.run ? null : (verdict.message as string);
};

interface Turn {
	log: TurnLog;
	cancelRequested: boolean;
	pid?: number;
}

interface Session extends HarnessSession {
	env?: Record<string, string>;
	turnTimeoutMs?: number;
	current?: Turn;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export class SpawnerHarness implements HarnessAdapter {
	readonly id: string;
	private readonly sessions = new Map<string, Session>();
	private readonly turns = new Map<string, Turn>();
	private readonly gate: TurnGate;
	private readonly drainMs: number;
	private spawnFn?: Spawn;

	constructor(private readonly options: SpawnerHarnessOptions) {
		this.id = `spawner:${options.runtime}`;
		this.gate = options.gate ?? defaultTurnGate;
		this.spawnFn = options.spawn;
		this.drainMs = options.drainMs ?? 250;
	}

	capabilities(): HarnessCapabilities {
		return {
			protocol: HARNESS_PROTOCOL_VERSION,
			harness: this.id,
			streaming: true,
			sessions: false,
			cancel: true,
			maxConcurrentTurns: 1,
			local: this.options.runtime === "shell",
		};
	}

	async start(options: StartOptions = {}): Promise<HarnessSession> {
		const session: Session = {
			id: nextId("hs"),
			harness: this.id,
			cwd: options.cwd ?? process.cwd(),
			env: options.env,
			turnTimeoutMs: options.turnTimeoutMs,
		};
		this.sessions.set(session.id, session);
		return { id: session.id, harness: session.harness, cwd: session.cwd };
	}

	send(sessionId: string, input: TurnInput): HarnessTurn {
		const session = this.sessions.get(sessionId);
		if (!session) throw new HarnessError("session_not_found", `no session ${sessionId}`);
		if (!input.text.trim()) throw new HarnessError("empty_input", "the turn has no text");
		if (session.current && !session.current.log.isEnded) {
			throw new HarnessError("session_busy", `session ${sessionId} is running a turn`);
		}
		const turn: Turn = { log: new TurnLog(nextId("ht")), cancelRequested: false };
		session.current = turn;
		this.turns.set(turn.log.turnId, turn);
		turn.log.push({ type: "turn.started", sessionId, harness: this.id });
		void this.run(session, turn, input.text);
		return {
			id: turn.log.turnId,
			sessionId,
			events: () => turn.log.read(),
			done: turn.log.done,
		};
	}

	async cancel(turnId: string): Promise<boolean> {
		const turn = this.turns.get(turnId);
		if (!turn || turn.log.isEnded) return false;
		turn.cancelRequested = true;
		if (turn.pid) {
			const pid = turn.pid;
			killProcessTree(pid, "SIGTERM");
			setTimeout(() => {
				if (!turn.log.isEnded) killProcessTree(pid, "SIGKILL");
			}, 2000).unref?.();
		}
		return true;
	}

	async stop(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		const turn = session.current;
		if (turn && !turn.log.isEnded) {
			await this.cancel(turn.log.turnId);
			await turn.log.done;
		}
	}

	private async run(session: Session, turn: Turn, text: string): Promise<void> {
		const t0 = Date.now();
		const end = (
			status: "completed" | "failed" | "cancelled" | "incomplete",
			extra: { error?: string; reason?: string } = {},
		) => {
			turn.log.push({
				type: "turn.ended",
				status,
				output: turn.log.text(),
				...extra,
				durationMs: Date.now() - t0,
			});
			this.turns.delete(turn.log.turnId);
		};

		let refusal: string | null;
		try {
			refusal = await this.gate(text, { runtime: this.options.runtime, cwd: session.cwd });
		} catch (err) {
			refusal = `the gate could not decide: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (turn.cancelRequested) return end("cancelled");
		if (refusal) return end("failed", { error: refusal });

		let child: RunningCLIAgent;
		try {
			const spawn =
				this.spawnFn ?? (await import("../../orchestration/universal-spawner")).spawnCLIAgent;
			this.spawnFn = spawn;
			// The child's depth goes last, so session env can never lower it (#3341).
			const { childAgentEnv } = await import("../../orchestration/index");
			child = spawn(this.options.runtime, text, {
				workingDirectory: session.cwd,
				timeout: session.turnTimeoutMs,
				env: { ...session.env, ...childAgentEnv() },
			});
		} catch (err) {
			return end("failed", { error: err instanceof Error ? err.message : String(err) });
		}

		const proc = child.process;
		turn.pid = proc?.pid ?? undefined;
		// Decode as UTF-8 at the stream, so a character split across chunks is never mangled.
		proc?.stdout?.setEncoding("utf8");
		proc?.stderr?.setEncoding("utf8");
		proc?.stdout?.on("data", (chunk: string) => turn.log.push({ type: "text.delta", text: chunk }));
		let stderr = "";
		proc?.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			turn.log.push({ type: "log", text: chunk });
		});
		// Prompts default No: the child gets no stdin, so nothing can wait on an answer.
		proc?.stdin?.end();
		if (turn.cancelRequested && turn.pid) killProcessTree(turn.pid, "SIGTERM");

		// The spawner resolves on "close", which a grandchild holding a pipe can delay
		// forever. "exit" plus a short drain bounds the wait.
		const exited = new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
			proc?.once("exit", (code) =>
				setTimeout(() => resolve({ code, timedOut: false }), this.drainMs),
			);
		});
		const closed = child.promise.then((r) => ({
			code: r.exitCode,
			timedOut: r.timedOut,
			stderr: r.stderr,
		}));
		const outcome: { code: number | null; timedOut: boolean; stderr?: string } = await Promise.race(
			[closed, exited],
		);

		if (turn.cancelRequested) return end("cancelled");
		if (outcome.timedOut) return end("incomplete", { reason: "timeout" });
		if (outcome.code === 0) return end("completed");
		const tail = (outcome.stderr ?? stderr).trim().split("\n").slice(-3).join("\n");
		end("failed", { error: tail || `exited with code ${outcome.code}` });
	}
}

/**
 * The entry point the product calls. Null unless EIGHT_HARNESS_PROTOCOL=1:
 * with the flag off, nothing about spawning changes.
 */
export function spawnerHarness(
	runtime: ProcessRuntime,
	env: Record<string, string | undefined> = process.env,
): SpawnerHarness | null {
	return harnessProtocolEnabled(env) ? new SpawnerHarness({ runtime }) : null;
}
