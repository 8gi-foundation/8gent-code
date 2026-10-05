/**
 * Resume after a crash or power cut (#3552).
 *
 * The daemon only wrote daemon-state.json on a clean SIGTERM/SIGINT, and
 * nothing read it back. These tests cover the replacement behind
 * EIGHT_RESUME_ON_BOOT=1:
 *   - a journal of open sessions, written atomically when a session starts
 *     and removed when it ends,
 *   - a boot reload that recreates each journaled session and restores its
 *     newest time-travel checkpoint, without running any tool call again,
 *   - the real path: a process that is SIGKILLed mid-task (no shutdown hook
 *     runs) and a fresh pool that brings the session back.
 *
 * Uses a REAL AgentPool and a REAL TimeTravelStore on temp dirs. No model is
 * contacted: nothing here calls chat().
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TimeTravelStore } from "../eight/timetravel/checkpoint-store";

const saved: Record<string, string | undefined> = {};
let root: string;
let journalPath: string;
let ttDir: string;
let mod: typeof import("./session-journal");
let AgentPool: typeof import("./agent-pool").AgentPool;

function newPool(journal?: InstanceType<typeof mod.SessionJournal>) {
	return new AgentPool(
		{ model: "none", runtime: "ollama", workingDirectory: root },
		journal ? { journal } : undefined,
	);
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "resume3552-"));
	const env: Record<string, string> = {
		EIGHT_DATA_DIR: path.join(root, "data"),
		EIGHT_TIMETRAVEL_DIR: path.join(root, "tt"),
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	mod = await import("./session-journal");
	({ AgentPool } = await import("./agent-pool"));
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	const run = fs.mkdtempSync(path.join(root, "run-"));
	journalPath = path.join(run, "sessions-journal.json");
	ttDir = path.join(run, "tt");
	process.env.EIGHT_TIMETRAVEL_DIR = ttDir;
});

describe("flag", () => {
	test("EIGHT_RESUME_ON_BOOT=1 enables, anything else does not", () => {
		expect(mod.resumeOnBootEnabled({ EIGHT_RESUME_ON_BOOT: "1" })).toBe(true);
		expect(mod.resumeOnBootEnabled({})).toBe(false);
		expect(mod.resumeOnBootEnabled({ EIGHT_RESUME_ON_BOOT: "0" })).toBe(false);
		expect(mod.resumeOnBootEnabled({ EIGHT_RESUME_ON_BOOT: "true" })).toBe(false);
	});
});

describe("SessionJournal", () => {
	test("upsert, replace by sessionId, remove, and no temp files left behind", () => {
		const j = new mod.SessionJournal(journalPath);
		expect(j.read()).toEqual([]);
		j.upsert({ sessionId: "a", channel: "api", ttSessionId: "session_1", createdAt: 1 });
		j.upsert({ sessionId: "b", channel: "os", ttSessionId: "session_2", createdAt: 2 });
		j.upsert({ sessionId: "a", channel: "api", ttSessionId: "session_3", createdAt: 3 });
		expect(j.read().map((e) => [e.sessionId, e.ttSessionId])).toEqual([
			["b", "session_2"],
			["a", "session_3"],
		]);
		j.remove("b");
		expect(j.read().map((e) => e.sessionId)).toEqual(["a"]);
		const leftovers = fs.readdirSync(path.dirname(journalPath)).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("a corrupt journal reads as empty instead of crashing boot", () => {
		fs.writeFileSync(journalPath, "{not json");
		expect(new mod.SessionJournal(journalPath).read()).toEqual([]);
	});
});

describe("AgentPool journaling", () => {
	test("default pool (no journal) writes nothing", () => {
		const pool = newPool();
		pool.createSession("s_default", "api");
		expect(fs.existsSync(journalPath)).toBe(false);
	});

	test("create journals the session with its checkpoint id; destroy removes it", () => {
		const journal = new mod.SessionJournal(journalPath);
		const pool = newPool(journal);
		pool.createSession("s_one", "table", { agentScope: "__table__", tenantId: "t1" });
		const [entry] = journal.read();
		expect(entry.sessionId).toBe("s_one");
		expect(entry.channel).toBe("table");
		expect(entry.ttSessionId).toBe(pool.getAgent("s_one")!.getTimeTravelSessionId());
		expect(entry.overrides).toEqual({ agentScope: "__table__", tenantId: "t1" });
		pool.destroySession("s_one");
		expect(journal.read()).toEqual([]);
	});
});

describe("resumeJournaledSessions", () => {
	test("restores the newest checkpoint into a recreated session, no chat run", () => {
		const journal = new mod.SessionJournal(journalPath);
		const before = newPool(journal);
		before.createSession("s_task", "api", { agentScope: "__table__" });
		before.createSession("s_fresh", "os");
		const agent = before.getAgent("s_task")!;
		const store = new TimeTravelStore({ dataDir: ttDir });
		const ttId = agent.getTimeTravelSessionId();
		store.save(ttId, [{ role: "user", content: "old" }], { reason: "interval", toolCallCount: 8 });
		const history = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "fix the build" },
			{ role: "assistant", content: "running tests" },
		];
		store.save(ttId, history, { reason: "interval", toolCallCount: 16 });

		// Crash: the old pool is simply abandoned. A new pool boots.
		const after = newPool(journal);
		const results = mod.resumeJournaledSessions(journal, after, store);

		expect(results.map((r) => r.sessionId).sort()).toEqual(["s_fresh", "s_task"]);
		const task = results.find((r) => r.sessionId === "s_task")!;
		expect(task.toolCallCount).toBe(16);
		expect(task.messageCount).toBe(3);
		expect(results.find((r) => r.sessionId === "s_fresh")!.checkpointId).toBeNull();

		const restored = after.getAgent("s_task")!;
		expect(restored.getMessageHistory().slice(1)).toEqual(history.slice(1));
		expect(after.getSessionInfo("s_task")).toEqual({ channel: "api", messageCount: 0, busy: false });

		// The journal now points at the new agent's lineage, which already
		// holds the restored state, so a second crash still resumes.
		const entry = journal.read().find((e) => e.sessionId === "s_task")!;
		expect(entry.ttSessionId).toBe(restored.getTimeTravelSessionId());
		expect(entry.overrides).toEqual({ agentScope: "__table__" });
		expect(store.latest(entry.ttSessionId)!.toolCallCount).toBe(16);
	});

	test("a missing checkpoint blob leaves the session empty instead of failing boot", () => {
		const journal = new mod.SessionJournal(journalPath);
		journal.upsert({ sessionId: "s_gone", channel: "api", ttSessionId: "session_gone", createdAt: 1 });
		const store = new TimeTravelStore({ dataDir: ttDir });
		const meta = store.save("session_gone", [{ role: "user", content: "x" }], { reason: "manual" });
		fs.rmSync(path.join(ttDir, "blobs"), { recursive: true, force: true });
		const pool = newPool(journal);
		const [r] = mod.resumeJournaledSessions(journal, pool, store);
		expect(meta.id).toBeTruthy();
		expect(r.checkpointId).toBeNull();
		expect(pool.hasSession("s_gone")).toBe(true);
	});
});

describe("SIGKILL mid-task", () => {
	test("a killed process's open session comes back with its last checkpoint", async () => {
		const script = path.join(path.dirname(journalPath), "crash.ts");
		const poolPath = path.join(import.meta.dir, "agent-pool.ts");
		const journalMod = path.join(import.meta.dir, "session-journal.ts");
		const storeMod = path.join(import.meta.dir, "..", "eight", "timetravel", "checkpoint-store.ts");
		fs.writeFileSync(
			script,
			`import { AgentPool } from ${JSON.stringify(poolPath)};
import { SessionJournal } from ${JSON.stringify(journalMod)};
import { TimeTravelStore } from ${JSON.stringify(storeMod)};
const journal = new SessionJournal(${JSON.stringify(journalPath)});
const pool = new AgentPool({ model: "none", runtime: "ollama", workingDirectory: ${JSON.stringify(root)} }, { journal });
pool.createSession("s_crash", "telegram");
const agent = pool.getAgent("s_crash");
const store = new TimeTravelStore({ dataDir: ${JSON.stringify(ttDir)} });
store.save(agent.getTimeTravelSessionId(), [
  { role: "system", content: "sys" },
  { role: "user", content: "deploy the site" },
  { role: "assistant", content: "step 3 of 5" },
], { reason: "interval", toolCallCount: 8 });
process.kill(process.pid, "SIGKILL");
`,
		);
		const proc = Bun.spawn([process.execPath, script], {
			env: { ...process.env, EIGHT_TIMETRAVEL_DIR: ttDir },
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
		expect(proc.signalCode).toBe("SIGKILL");

		const journal = new mod.SessionJournal(journalPath);
		expect(journal.read().map((e) => e.sessionId)).toEqual(["s_crash"]);
		const pool = newPool(journal);
		const [r] = mod.resumeJournaledSessions(journal, pool, new TimeTravelStore({ dataDir: ttDir }));
		expect(r.sessionId).toBe("s_crash");
		expect(r.toolCallCount).toBe(8);
		expect(pool.getAgent("s_crash")!.getMessageHistory().slice(1)).toEqual([
			{ role: "user", content: "deploy the site" },
			{ role: "assistant", content: "step 3 of 5" },
		]);
		expect(pool.getSessionInfo("s_crash")!.channel).toBe("telegram");
	}, 60_000);
});
