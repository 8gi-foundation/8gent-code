/**
 * Harness protocol (docs/specs/HARNESS-PROTOCOL.md).
 *
 * Covers:
 *   - the conformance rubric passes on an in-memory adapter
 *   - each planted defect fails the check written for it, so the rubric bites
 *   - the spawner adapter passes the rubric on the local shell runtime
 *   - the flag ships off; gates refuse before anything is spawned
 *
 * Local only: the shell turns are printf, sleep and exit. No network, no model.
 */

import { describe, expect, it } from "bun:test";
import {
	type CheckResult,
	type ConformanceFixture,
	failures,
	runConformance,
} from "../protocol/conformance";
import {
	type ProcessRuntime,
	SpawnerHarness,
	defaultTurnGate,
	spawnerHarness,
} from "../protocol/spawner-adapter";
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

const allow = async () => null;

const shellFixture: ConformanceFixture = {
	echo: { input: { text: "printf 'hello harness \\342\\234\\223'" }, expect: "hello harness ✓" },
	// exec, so sleep is the spawned pid: the spawner does not start a process
	// group, so a cancel cannot reach a grandchild (see the spec's known gaps).
	long: { text: "printf tick; exec sleep 30" },
	fail: { text: "echo boom >&2; exit 3" },
	deadlineMs: 8000,
};

describe("SpawnerHarness on the shell runtime", () => {
	it("passes every conformance check", async () => {
		const results = await runConformance(
			new SpawnerHarness({ runtime: "shell", gate: allow }),
			shellFixture,
		);
		expect(failures(results)).toEqual([]);
		expect(results.every((r) => r.outcome === "pass")).toBe(true);
	}, 60_000);

	it("reports the shell as local and a hosted runtime as not", () => {
		expect(new SpawnerHarness({ runtime: "shell" }).capabilities().local).toBe(true);
		const hosted = new SpawnerHarness({ runtime: "hosted-cli" as ProcessRuntime });
		expect(hosted.capabilities().local).toBe(false);
	});

	it("puts the stderr tail in a failed turn's error", async () => {
		const h = new SpawnerHarness({ runtime: "shell", gate: allow });
		const s = await h.start();
		const end = await h.send(s.id, { text: "echo boom >&2; exit 3" }).done;
		expect(end.status).toBe("failed");
		expect(end.error).toBe("boom");
	});

	it("ends a turn that hits the session time limit as incomplete", async () => {
		const h = new SpawnerHarness({ runtime: "shell", gate: allow });
		const s = await h.start({ turnTimeoutMs: 300 });
		const end = await h.send(s.id, { text: "sleep 10" }).done;
		expect(end.status).toBe("incomplete");
		expect(end.reason).toBe("timeout");
	}, 10_000);

	it("never spawns a turn the gate refuses", async () => {
		let spawned = 0;
		const h = new SpawnerHarness({
			runtime: "shell",
			gate: async () => "[BLOCKED] not today",
			spawn: () => {
				spawned++;
				throw new Error("must not spawn");
			},
		});
		const s = await h.start();
		const end = await h.send(s.id, { text: "printf hi" }).done;
		expect(end).toMatchObject({ status: "failed", error: "[BLOCKED] not today" });
		expect(spawned).toBe(0);
	});
});

describe("defaults ship off and closed", () => {
	it("the flag is off unless set to 1", () => {
		expect(harnessProtocolEnabled({})).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "0" })).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "true" })).toBe(false);
		expect(harnessProtocolEnabled({ [HARNESS_PROTOCOL_FLAG]: "1" })).toBe(true);
	});

	it("spawnerHarness gives nothing while the flag is off", () => {
		expect(spawnerHarness("shell", {})).toBeNull();
		expect(spawnerHarness("shell", { [HARNESS_PROTOCOL_FLAG]: "1" })).toBeInstanceOf(
			SpawnerHarness,
		);
	});

	it("the default gate refuses a hosted runtime without the opt-in", async () => {
		const saved = process.env.EIGHT_ALLOW_HOSTED;
		// biome-ignore lint/performance/noDelete: process.env needs a real unset, not "undefined"
		delete process.env.EIGHT_ALLOW_HOSTED;
		try {
			const why = await defaultTurnGate("do the thing", {
				runtime: "hosted-cli" as ProcessRuntime,
				cwd: process.cwd(),
			});
			expect(why).toContain("EIGHT_ALLOW_HOSTED=1");
		} finally {
			if (saved !== undefined) process.env.EIGHT_ALLOW_HOSTED = saved;
		}
	});

	it("the default gate passes a plain local shell turn", async () => {
		expect(await defaultTurnGate("printf ok", { runtime: "shell", cwd: process.cwd() })).toBeNull();
	});
});
