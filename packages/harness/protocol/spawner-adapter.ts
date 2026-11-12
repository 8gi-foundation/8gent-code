/**
 * HarnessAdapter over the existing process path, spawnCLIAgent in
 * packages/orchestration/universal-spawner.ts. Each turn is one child
 * process: stdout streams as text.delta, stderr as log, the exit code
 * decides the status. Nothing carries between turns, so `sessions` is false.
 *
 * Every turn goes through planProcessChild (packages/orchestration/
 * delegation-tools.ts), the same function spawn_agent calls, so a turn is
 * refused exactly when spawn_agent would refuse the same child. There is no
 * way to pass a different gate. The plan decides the task and the whole
 * environment the child is spawned with; session env is judged with it.
 */

import { killProcessTree } from "../../core/shell";
import type { ProcessChildRuntime } from "../../orchestration/delegation-tools";
import type { RunningCLIAgent } from "../../orchestration/universal-spawner";
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
export type ProcessRuntime = ProcessChildRuntime;

/** How long to wait for pipes to drain once the process has exited. */
const DRAIN_MS = 250;

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

class SpawnerHarness implements HarnessAdapter {
	readonly id: string;
	private readonly sessions = new Map<string, Session>();
	private readonly turns = new Map<string, Turn>();

	constructor(
		private readonly runtime: ProcessRuntime,
		private readonly permissionMode?: unknown,
	) {
		this.id = `spawner:${runtime}`;
	}

	capabilities(): HarnessCapabilities {
		return {
			protocol: HARNESS_PROTOCOL_VERSION,
			harness: this.id,
			streaming: true,
			sessions: false,
			cancel: true,
			maxConcurrentTurns: 1,
			local: this.runtime === "shell",
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

	/**
	 * The turn is judged in the caller's context: the permission mode and
	 * provider pin bound where send() is called are the ones that apply.
	 */
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

		let child: RunningCLIAgent;
		try {
			const { planProcessChild } = await import("../../orchestration/delegation-tools");
			const plan = await planProcessChild({
				runtime: this.runtime,
				task: text,
				cwd: session.cwd,
				permissionMode: this.permissionMode,
				env: session.env,
			});
			if (turn.cancelRequested) return end("cancelled");
			if (!plan.run) return end("failed", { error: plan.refusal });
			const { spawnCLIAgent } = await import("../../orchestration/universal-spawner");
			child = spawnCLIAgent(plan.runtime, plan.task, {
				workingDirectory: session.cwd,
				timeout: session.turnTimeoutMs,
				env: plan.env,
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
			proc?.once("exit", (code) => setTimeout(() => resolve({ code, timedOut: false }), DRAIN_MS));
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
 * The only way to build a process harness. Null unless EIGHT_HARNESS_PROTOCOL=1:
 * with the flag off, nothing about spawning changes. `permissionMode` is the
 * mode requested for every child, clamped to the caller's as spawn_agent does.
 */
export function spawnerHarness(
	runtime: ProcessRuntime,
	options: { env?: Record<string, string | undefined>; permissionMode?: unknown } = {},
): HarnessAdapter | null {
	return harnessProtocolEnabled(options.env ?? process.env)
		? new SpawnerHarness(runtime, options.permissionMode)
		: null;
}
