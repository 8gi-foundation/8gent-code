/**
 * Goal resume after a hard kill: fail-closed conformance (#4113).
 *
 * A real child process runs GoalManager with a real WorkspaceDb (goal_runs +
 * goal_events) and a real hash-chained ledger. The executor blocks inside
 * turn 3, and a second process force-kills the child there (kill -KILL on
 * POSIX, Stop-Process -Force on Windows). A fresh manager on the same files
 * then calls resume().
 *
 * The contract: resume() either reports the run ready at the offset both
 * stores agree on, or refuses with "ledger verify failed". It never says yes
 * over a ledger that is tampered, truncated, torn, missing, signed with
 * another key, or unverifiable. No model is contacted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forceKillFromSecondProcess, isAlive, waitForFile } from "../../tests/force-kill";
import { rmRetry } from "../../tests/rm-retry";
import { WorkspaceDb } from "../db/src/workspace-db";
import {
	type GoalExecutorFactory,
	GoalManager,
	type GoalRpcOutbound,
	handleGoalRpc,
} from "./goal-rpc";

const KILL_TURN = 3;

let root: string;
let dbPath: string;
let runsDir: string;
let key: Buffer;
let runId: string;
let ledgerFile: string;
let pristine: string;
let killed: { exitCode: number | null; signalCode: string | null; pid: number; survived: boolean };
const workspaces: WorkspaceDb[] = [];

/** resume() must never need an executor; building one is a failure. */
const noFactory: GoalExecutorFactory = {
	async build() {
		throw new Error("resume must not build an executor");
	},
};

function manager(opts: { ledgerKey?: Buffer | null } = {}): GoalManager {
	const workspace = new WorkspaceDb({ dbPath });
	workspaces.push(workspace);
	return new GoalManager({
		factory: noFactory,
		workspace,
		ledgerKey: opts.ledgerKey === null ? undefined : (opts.ledgerKey ?? key),
		ledgerBaseDir: runsDir,
	});
}

/** resume() plus every warning it logged. */
function resumeWithLog(m: GoalManager, id = runId): { ok: boolean; log: string } {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const ok = m.resume(id);
		return { ok, log: warn.mock.calls.map((c) => c.join(" ")).join("\n") };
	} finally {
		warn.mockRestore();
	}
}

function ledgerLines(): string[] {
	return pristine.trimEnd().split("\n");
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-resume-4113-"));
	dbPath = path.join(root, "state.db");
	runsDir = path.join(root, "runs");
	key = randomBytes(32);
	const keyFile = path.join(root, "state-hmac.key");
	fs.writeFileSync(keyFile, key.toString("hex"));
	const ready = path.join(root, "goal.ready");
	const survivedFile = path.join(root, "goal.survived");
	const script = path.join(root, "goal-crash.ts");
	fs.writeFileSync(
		script,
		`import { readFileSync, writeFileSync } from "node:fs";
import { GoalManager } from ${JSON.stringify(path.join(import.meta.dir, "goal-rpc.ts"))};
import { WorkspaceDb } from ${JSON.stringify(path.join(import.meta.dir, "..", "db", "src", "workspace-db.ts"))};
let started = "";
const factory = {
  async build() {
    return {
      executor: {
        model: "stub-executor",
        async turn(input) {
          if (input.turn >= ${KILL_TURN}) {
            while (!started) await new Promise((r) => setTimeout(r, 5));
            writeFileSync(${JSON.stringify(ready)}, started);
            await new Promise(() => {}); // mid-step: only a kill from outside ends this
          }
          return { summary: "turn " + input.turn, tokensIn: 1, tokensOut: 1 };
        },
        abort() {},
      },
      judge: {
        model: "stub-judge",
        async score() { return { decision: "continue", confidence: 0.1, summary: "keep going" }; },
      },
    };
  },
};
const manager = new GoalManager({
  factory,
  workspace: new WorkspaceDb({ dbPath: ${JSON.stringify(dbPath)} }),
  ledgerKey: Buffer.from(readFileSync(${JSON.stringify(keyFile)}, "utf8"), "hex"),
  ledgerBaseDir: ${JSON.stringify(runsDir)},
});
const { runId } = await manager.start({ sessionId: "s_goal", goal: "ship the fix", budget: { turns: 10 } });
started = runId;
setTimeout(() => { writeFileSync(${JSON.stringify(survivedFile)}, "1"); process.exit(0); }, 30_000);
`,
	);
	const proc = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
	await waitForFile(ready, proc);
	runId = fs.readFileSync(ready, "utf8");
	await forceKillFromSecondProcess(proc.pid);
	await proc.exited;
	killed = {
		exitCode: proc.exitCode,
		signalCode: proc.signalCode,
		pid: proc.pid,
		survived: fs.existsSync(survivedFile),
	};
	ledgerFile = path.join(runsDir, runId, "ledger.jsonl");
	pristine = fs.readFileSync(ledgerFile, "utf8");
}, 60_000);

beforeEach(() => {
	fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
	fs.writeFileSync(ledgerFile, pristine);
});

afterAll(() => {
	for (const w of workspaces) {
		try {
			w.close();
		} catch {
			// already closed
		}
	}
	rmRetry(root);
});

describe("the kill", () => {
	test("the child died mid-step from outside, not by finishing", () => {
		expect(killed.exitCode).not.toBe(0);
		if (process.platform !== "win32") expect(killed.signalCode).toBe("SIGKILL");
		expect(isAlive(killed.pid)).toBe(false);
		expect(killed.survived).toBe(false);
	});
});

describe("intact ledger: resume reports the run ready at the right offset", () => {
	test("both stores end at the turn the kill cut, and resume says yes", () => {
		const m = manager();
		const persistence = m.getPersistence()!;
		expect(persistence.getRun(runId)!.status).toBe("running");
		const events = persistence.listEventsForRun(runId);
		const entries = ledgerLines().map((l) => JSON.parse(l));
		expect(entries.map((e) => e.kind)).toEqual(events.map((e) => e.kind));
		expect(entries.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
		const last = events[events.length - 1];
		expect(last.kind).toBe("turn.requested");
		expect(last.payload.turn).toBe(KILL_TURN);
		expect(entries[entries.length - 1].payload.turn).toBe(KILL_TURN);

		const { ok, log } = resumeWithLog(m);
		expect(log).toBe("");
		expect(ok).toBe(true);
		// Verifying never writes to the audit log.
		expect(fs.readFileSync(ledgerFile, "utf8")).toBe(pristine);
	});

	test("goal.resume on the wire answers known:true", async () => {
		const sent: GoalRpcOutbound[] = [];
		await handleGoalRpc(
			{ type: "goal.resume", runId },
			{ manager: manager(), send: (m) => sent.push(m) },
		);
		expect(sent).toEqual([{ type: "goal.resume:ok", runId, known: true }]);
	});
});

describe("damaged ledger: resume refuses with a ledger verification failure", () => {
	const refuses = (log: string, seq?: number) => {
		expect(log).toContain(`[GoalManager] resume(${runId}): ledger verify failed`);
		if (seq !== undefined) expect(log).toContain(`at seq=${seq}`);
	};

	test("a tampered payload mid-chain", () => {
		const lines = ledgerLines();
		const e = JSON.parse(lines[1]);
		e.payload = { ...e.payload, injected: "rm -rf /" };
		lines[1] = JSON.stringify(e);
		fs.writeFileSync(ledgerFile, `${lines.join("\n")}\n`);
		const { ok, log } = resumeWithLog(manager());
		expect(ok).toBe(false);
		refuses(log, 2);
	});

	test("the tail truncated by whole lines (the prefix still chains)", () => {
		const lines = ledgerLines();
		fs.writeFileSync(ledgerFile, `${lines.slice(0, -2).join("\n")}\n`);
		const { ok, log } = resumeWithLog(manager());
		expect(ok).toBe(false);
		refuses(log, lines.length - 1);
	});

	test("a torn last line, as a kill mid-append leaves it", () => {
		fs.writeFileSync(ledgerFile, pristine.slice(0, pristine.trimEnd().length - 25));
		const { ok, log } = resumeWithLog(manager());
		expect(ok).toBe(false);
		refuses(log);
	});

	test("the ledger file deleted", () => {
		fs.rmSync(ledgerFile);
		const { ok, log } = resumeWithLog(manager());
		expect(ok).toBe(false);
		refuses(log, 1);
	});

	test("a ledger signed with a different key", () => {
		const { ok, log } = resumeWithLog(manager({ ledgerKey: randomBytes(32) }));
		expect(ok).toBe(false);
		refuses(log, 1);
	});

	test("no ledger key at all: nothing can be verified, so no", () => {
		const { ok, log } = resumeWithLog(manager({ ledgerKey: null }));
		expect(ok).toBe(false);
		refuses(log);
	});

	test("goal.resume on the wire answers known:false for a truncated ledger", async () => {
		fs.writeFileSync(ledgerFile, `${ledgerLines().slice(0, -1).join("\n")}\n`);
		const sent: GoalRpcOutbound[] = [];
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await handleGoalRpc(
				{ type: "goal.resume", runId },
				{ manager: manager(), send: (m) => sent.push(m) },
			);
		} finally {
			warn.mockRestore();
		}
		expect(sent).toEqual([{ type: "goal.resume:ok", runId, known: false }]);
	});

	test("an unknown run is not resumable", () => {
		const { ok } = resumeWithLog(manager(), "g_never_started");
		expect(ok).toBe(false);
	});
});

/**
 * goal_events is the store the orchestrator replays, and its rows are not
 * signed. A row the ledger does not vouch for, field for field, is a refusal.
 */
describe("tampered goal_events, ledger intact: resume refuses", () => {
	type Row = { run_id: string; seq: number; kind: string; payload: string; ts: number };
	/** Run `damage` on the events table, then put every row back as it was. */
	function withDamagedEvents(damage: (w: WorkspaceDb) => void): { ok: boolean; log: string } {
		const w = new WorkspaceDb({ dbPath });
		workspaces.push(w);
		const rows = w.db
			.query<Row, [string]>("SELECT * FROM goal_events WHERE run_id = ? ORDER BY seq")
			.all(runId);
		try {
			damage(w);
			return resumeWithLog(manager());
		} finally {
			w.db.prepare("DELETE FROM goal_events WHERE run_id = ?").run(runId);
			const put = w.db.prepare(
				"INSERT INTO goal_events (run_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)",
			);
			for (const r of rows) put.run(r.run_id, r.seq, r.kind, r.payload, r.ts);
		}
	}

	test("a goal_events payload rewritten, kind unchanged", () => {
		const { ok, log } = withDamagedEvents((w) =>
			w.db
				.prepare("UPDATE goal_events SET payload = ? WHERE run_id = ? AND seq = 2")
				.run(JSON.stringify({ turn: 99, injected: "evil" }), runId),
		);
		expect(ok).toBe(false);
		expect(log).toContain(`[GoalManager] resume(${runId}): ledger verify failed at seq=2`);
	});

	test("goal_events truncated, ledger intact", () => {
		const n = ledgerLines().length;
		const { ok, log } = withDamagedEvents((w) =>
			w.db.prepare("DELETE FROM goal_events WHERE run_id = ? AND seq = ?").run(runId, n),
		);
		expect(ok).toBe(false);
		expect(log).toContain(`[GoalManager] resume(${runId}): ledger verify failed at seq=${n}`);
	});

	test("after both, the restored rows resume again (the damage was the cause)", () => {
		expect(resumeWithLog(manager()).ok).toBe(true);
	});
});
