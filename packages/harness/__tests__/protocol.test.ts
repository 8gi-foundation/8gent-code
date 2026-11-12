/**
 * Harness protocol (docs/specs/HARNESS-PROTOCOL.md).
 *
 * Covers:
 *   - the conformance rubric passes on an in-memory adapter
 *   - each planted defect fails the check written for it, so the rubric bites
 *   - the spawner adapter passes the rubric on the local shell runtime, through the real gate
 *   - parity: spawn_agent and the spawner adapter refuse the same children with the same words
 *   - the flag ships off
 *
 * Local only: the shell turns are printf, sleep, exit and two tiny scripts. No network, no
 * model: the one hosted case runs with an empty PATH, so even a broken gate finds no binary.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOSTED_CLI_RUNTIME, spawnAgentTool } from "../../orchestration/delegation-tools";
import { runWithProviderPin } from "../../orchestration/provider-pin";
import { createPermissionHolder, runWithPermissionHolder } from "../../permissions/permission-mode";
import {
	type CheckResult,
	type ConformanceFixture,
	failures,
	runConformance,
} from "../protocol/conformance";
import { type ProcessRuntime, spawnerHarness } from "../protocol/spawner-adapter";
import {
	HARNESS_PROTOCOL_FLAG,
	HARNESS_PROTOCOL_VERSION,
	type HarnessAdapter,
	type HarnessCapabilities,
	HarnessError,
	type HarnessEvent,
	type HarnessSession,
	type HarnessTurn,
	type TurnInput,
	TurnLog,
	harnessProtocolEnabled,
} from "../protocol/types";

// ── An in-memory adapter ─────────────────────────────────────────
//
// Turn text is a tiny script: "say:a b c" streams the words and completes,
// "wait:x" streams x and runs until cancelled, "fail:why" fails.

type Defect = "drop-event" | "cancel-fails" | "unstable-caps" | "no-busy" | "late-reader-misses";

class MemoryHarness implements HarnessAdapter {
	readonly id = "memory";
	private sessions = new Map<string, { busy?: TurnLog }>();
	private turns = new Map<string, TurnLog>();
	private n = 0;
	private capsCalls = 0;

	constructor(private defect?: Defect) {}

	capabilities(): HarnessCapabilities {
		this.capsCalls++;
		return {
			protocol:
				this.defect === "unstable-caps" && this.capsCalls > 1 ? "old" : HARNESS_PROTOCOL_VERSION,
			harness: this.id,
			streaming: true,
			sessions: true,
			cancel: true,
			maxConcurrentTurns: 1,
			local: true,
		};
	}

	async start(): Promise<HarnessSession> {
		const id = `m${++this.n}`;
		this.sessions.set(id, {});
		return { id, harness: this.id, cwd: "/memory" };
	}

	send(sessionId: string, input: TurnInput): HarnessTurn {
		const s = this.sessions.get(sessionId);
		if (!s) throw new HarnessError("session_not_found", sessionId);
		if (!input.text.trim()) throw new HarnessError("empty_input", "empty");
		if (s.busy && !s.busy.isEnded && this.defect !== "no-busy") {
			throw new HarnessError("session_busy", sessionId);
		}
		const log = new TurnLog(`t${++this.n}`);
		s.busy = log;
		this.turns.set(log.turnId, log);
		log.push({ type: "turn.started", sessionId, harness: this.id });
		void this.play(log, input.text);
		const defect = this.defect;
		let reads = 0;
		return {
			id: log.turnId,
			sessionId,
			async *events(): AsyncIterable<HarnessEvent> {
				const first = reads++ === 0;
				for await (const e of log.read()) {
					if (defect === "drop-event" && e.seq === 1) continue;
					if (defect === "late-reader-misses" && !first && e.type === "text.delta") continue;
					yield e;
				}
			},
			done: log.done,
		};
	}

	private async play(log: TurnLog, text: string): Promise<void> {
		const tick = () => new Promise((r) => setTimeout(r, 1));
		const t0 = Date.now();
		const [verb, rest = ""] = text.split(/:(.*)/s);
		await tick();
		if (verb === "fail") {
			log.push({ type: "turn.ended", status: "failed", output: "", error: rest, durationMs: 0 });
			return;
		}
		const words = rest.split(/(?<= )/);
		for (const w of words) {
			if (log.isEnded) return;
			log.push({ type: "text.delta", text: w });
			await tick();
		}
		if (verb === "wait") return; // runs until cancel
		log.push({
			type: "turn.ended",
			status: "completed",
			output: log.text(),
			durationMs: Date.now() - t0,
		});
	}

	async cancel(turnId: string): Promise<boolean> {
		const log = this.turns.get(turnId);
		if (!log || log.isEnded) return false;
		const failed = this.defect === "cancel-fails";
		log.push({
			type: "turn.ended",
			status: failed ? "failed" : "cancelled",
			output: log.text(),
			...(failed ? { error: "killed" } : {}),
			durationMs: 0,
		});
		return true;
	}

	async stop(sessionId: string): Promise<void> {
		const s = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		if (s?.busy) await this.cancel(s.busy.turnId);
	}
}

const memoryFixture: ConformanceFixture = {
	echo: { input: { text: "say:hello in memory" }, expect: "hello in memory" },
	long: { text: "wait:tick" },
	fail: { text: "fail:planned failure" },
	deadlineMs: 2000,
};

function outcome(results: CheckResult[], id: string): string | undefined {
	return results.find((r) => r.id === id)?.outcome;
}

describe("conformance rubric", () => {
	it("passes every check on the in-memory adapter", async () => {
		const results = await runConformance(new MemoryHarness(), memoryFixture);
		expect(failures(results)).toEqual([]);
		expect(results.filter((r) => r.outcome === "pass")).toHaveLength(17);
	});

	const planted: Array<[Defect, string]> = [
		["unstable-caps", "H-01"],
		["drop-event", "H-06"],
		["late-reader-misses", "H-10"],
		["no-busy", "H-14"],
		["cancel-fails", "H-15"],
	];
	for (const [defect, id] of planted) {
		it(`catches ${defect} at ${id}`, async () => {
			const results = await runConformance(new MemoryHarness(defect), memoryFixture);
			expect(outcome(results, id)).toBe("fail");
		});
	}
});

// ── The spawner adapter, on the local shell ───────────────────────

const ON = { [HARNESS_PROTOCOL_FLAG]: "1" };
const shellHarness = () => spawnerHarness("shell", { env: ON }) as HarnessAdapter;

// The sanitiser refuses chaining, so the two multi-step turns are scripts in the session's
// folder. long.sh execs sleep, so sleep is the spawned pid: the spawner does not start a
// process group, so a cancel cannot reach a grandchild (see the spec's known gaps).
const work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-protocol-"));
fs.writeFileSync(path.join(work, "long.sh"), "printf tick\nexec sleep 30\n");
fs.writeFileSync(path.join(work, "fail.sh"), "echo boom >&2\nexit 3\n");
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const shellFixture: ConformanceFixture = {
	echo: { input: { text: "printf 'hello harness \\342\\234\\223'" }, expect: "hello harness ✓" },
	long: { text: "sh long.sh" },
	fail: { text: "sh fail.sh" },
	start: { cwd: work },
	deadlineMs: 8000,
};

describe("spawner adapter on the shell runtime", () => {
	it("passes every conformance check through the real gate", async () => {
		const results = await runConformance(shellHarness(), shellFixture);
		expect(failures(results)).toEqual([]);
		expect(results.every((r) => r.outcome === "pass")).toBe(true);
	}, 60_000);

	it("reports the shell as local and the hosted runtime as not", () => {
		expect(shellHarness().capabilities().local).toBe(true);
		const hosted = spawnerHarness(HOSTED_CLI_RUNTIME, { env: ON }) as HarnessAdapter;
		expect(hosted.capabilities().local).toBe(false);
	});

	it("puts the stderr tail in a failed turn's error", async () => {
		const h = shellHarness();
		const s = await h.start({ cwd: work });
		const end = await h.send(s.id, { text: "sh fail.sh" }).done;
		expect(end).toMatchObject({ status: "failed", error: "boom" });
	});

	it("ends a turn that hits the session time limit as incomplete", async () => {
		const h = shellHarness();
		const s = await h.start({ cwd: work, turnTimeoutMs: 300 });
		const end = await h.send(s.id, { text: "sleep 10" }).done;
		expect(end).toMatchObject({ status: "incomplete", reason: "timeout" });
	}, 10_000);
});

// ── Parity with spawn_agent ──────────────────────────────────────

/** spawn_agent's answer: a refusal string, or JSON naming the started child. */
async function viaSpawnAgent(runtime: ProcessRuntime, task: string): Promise<string> {
	return spawnAgentTool(work, task, runtime);
}

/** The harness's answer for the same child, in the same context. */
async function viaHarness(
	runtime: ProcessRuntime,
	task: string,
	env?: Record<string, string>,
): Promise<{ status: string; error?: string }> {
	const h = spawnerHarness(runtime, { env: ON }) as HarnessAdapter;
	const s = await h.start({ cwd: work, env });
	return h.send(s.id, { text: task }).done;
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	const apply = (v: Record<string, string | undefined>) => {
		for (const [k, val] of Object.entries(v)) {
			// process.env needs a real unset, not the string "undefined".
			if (val === undefined) delete process.env[k];
			else process.env[k] = val;
		}
	};
	apply(vars);
	try {
		return await fn();
	} finally {
		apply(saved);
	}
}

describe("parity: the harness refuses what spawn_agent refuses, in the same words", () => {
	it("a caller in plan mode starts nothing", async () => {
		const plan = createPermissionHolder("plan");
		const tool = await runWithPermissionHolder(plan, () => viaSpawnAgent("shell", "touch marker"));
		const turn = await runWithPermissionHolder(plan, () => viaHarness("shell", "touch marker"));
		expect(tool).not.toContain("agentId");
		expect(turn).toMatchObject({ status: "failed", error: tool });
		expect(fs.existsSync(path.join(work, "marker"))).toBe(false);
	});

	it("a command the sanitiser denies", async () => {
		const tool = await viaSpawnAgent("shell", "echo $(id)");
		const turn = await viaHarness("shell", "echo $(id)");
		expect(tool).toStartWith("[BLOCKED]");
		expect(turn).toMatchObject({ status: "failed", error: tool });
	});

	it("a hosted runtime without the opt-in", async () => {
		await withEnv({ EIGHT_ALLOW_HOSTED: undefined, PATH: "" }, async () => {
			const tool = await viaSpawnAgent(HOSTED_CLI_RUNTIME, "do the thing");
			const turn = await viaHarness(HOSTED_CLI_RUNTIME, "do the thing");
			expect(tool).toContain("EIGHT_ALLOW_HOSTED=1");
			expect(turn).toMatchObject({ status: "failed", error: tool });
		});
	});

	it("a session pinned to another provider", async () => {
		await withEnv({ EIGHT_ALLOW_HOSTED: "1", PATH: "" }, async () => {
			const pin = { runtime: "ollama" };
			const tool = await runWithProviderPin(pin, () =>
				viaSpawnAgent(HOSTED_CLI_RUNTIME, "do the thing"),
			);
			const turn = await runWithProviderPin(pin, () =>
				viaHarness(HOSTED_CLI_RUNTIME, "do the thing"),
			);
			expect(tool).toContain("pinned to ollama");
			expect(turn).toMatchObject({ status: "failed", error: tool });
		});
	});

	it("a $VAR that only the session env sets is judged with the value the shell gets", async () => {
		// The boundary only judges paths that exist, so plant a key in the suite's temp HOME
		// (tests/preload-temp-home.ts), never the real one.
		const home = process.env.HOME as string;
		expect(home).not.toBe(os.homedir());
		const keys = path.join(home, ".ssh");
		fs.mkdirSync(keys, { recursive: true });
		fs.writeFileSync(path.join(keys, "id_rsa"), "not a key\n");
		const task = "cat $KEYS/id_rsa";
		const tool = await withEnv({ KEYS: keys }, () => viaSpawnAgent("shell", task));
		const turn = await withEnv({ KEYS: undefined }, () =>
			viaHarness("shell", task, { KEYS: keys }),
		);
		expect(tool).toContain("never reads credential files");
		expect(turn).toMatchObject({ status: "failed", error: tool });
	});
});

describe("defaults ship off", () => {
	it("the flag is off unless set to 1", () => {
		expect(harnessProtocolEnabled({})).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "0" })).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "true" })).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "1" })).toBe(true);
	});

	it("spawnerHarness gives nothing while the flag is off", () => {
		expect(spawnerHarness("shell", { env: {} })).toBeNull();
		expect(spawnerHarness("shell", { env: ON })).not.toBeNull();
	});
});
