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

	test("the journal file is owner-only (0600)", () => {
		const j = new mod.SessionJournal(journalPath);
		j.upsert({
			sessionId: "a",
			channel: "api",
			ttSessionId: "session_1",
			createdAt: 1,
			overrides: { clerkId: "u1" },
		});
		expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
		// A rewrite keeps it owner-only, even over a file that was looser.
		fs.chmodSync(journalPath, 0o644);
		j.upsert({ sessionId: "b", channel: "api", ttSessionId: "session_2", createdAt: 2 });
		expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
	});

	test("a failed write throws and leaves no temp file behind", () => {
		// The journal path is a non-empty directory, so the final rename fails.
		fs.mkdirSync(journalPath);
		fs.writeFileSync(path.join(journalPath, "occupied"), "x");
		const j = new mod.SessionJournal(journalPath);
		expect(() =>
			j.upsert({ sessionId: "a", channel: "api", ttSessionId: "session_1", createdAt: 1 }),
		).toThrow();
		const leftovers = fs.readdirSync(path.dirname(journalPath)).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("malformed entries are dropped on read; valid ones are kept", () => {
		const good = {
			sessionId: "table:ws-8gi--x:8TO",
			channel: "table",
			ttSessionId: "session_1_ab",
			createdAt: 1,
		};
		fs.writeFileSync(
			journalPath,
			JSON.stringify({
				version: 1,
				sessions: [
					good,
					{ channel: "api", ttSessionId: "session_2", createdAt: 2 },
					{ sessionId: "b", channel: "api", ttSessionId: "../outside", createdAt: 3 },
					{ sessionId: "c", channel: "api", ttSessionId: "a/b", createdAt: 4 },
					{ sessionId: "d", channel: "api", ttSessionId: "session..x", createdAt: 5 },
					{ sessionId: "e", channel: "api", ttSessionId: "session_5", createdAt: "6" },
					{
						sessionId: "f",
						channel: "api",
						ttSessionId: "session_6",
						createdAt: 7,
						overrides: [1],
					},
					{ sessionId: "g\n", channel: "api", ttSessionId: "session_7", createdAt: 8 },
					null,
					"s_x",
				],
			}),
		);
		expect(new mod.SessionJournal(journalPath).read()).toEqual([good]);
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
		expect(after.getSessionInfo("s_task")).toEqual({
			channel: "api",
			messageCount: 0,
			busy: false,
		});

		// The journal now points at the new agent's lineage, which already
		// holds the restored state, so a second crash still resumes.
		const entry = journal.read().find((e) => e.sessionId === "s_task")!;
		expect(entry.ttSessionId).toBe(restored.getTimeTravelSessionId());
		expect(entry.overrides).toEqual({ agentScope: "__table__" });
		expect(store.latest(entry.ttSessionId)!.toolCallCount).toBe(16);
	});

	test("a failed restore keeps the old checkpoint in the journal so the next start retries", () => {
		const journal = new mod.SessionJournal(journalPath);
		const before = newPool(journal);
		before.createSession("s_retry", "api", { tenantId: "t1" });
		const oldTtId = before.getAgent("s_retry")!.getTimeTravelSessionId();
		const store = new TimeTravelStore({ dataDir: ttDir });
		const history = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "migrate the db" },
			{ role: "assistant", content: "halfway" },
		];
		store.save(oldTtId, history, { reason: "interval", toolCallCount: 4 });

		// First boot: the restore hits a transient error.
		const first = newPool(journal);
		const failing: import("./session-journal").ResumePool = {
			createSession: (...args) => first.createSession(...args),
			getAgent: (id) => {
				const a = first.getAgent(id);
				if (!a) return null;
				return {
					adoptTimeTravelFork: () => {
						throw new Error("EMFILE: too many open files");
					},
					getTimeTravelSessionId: () => a.getTimeTravelSessionId(),
				};
			},
		};
		const [r1] = mod.resumeJournaledSessions(journal, failing, store);
		expect(r1.checkpointId).toBeNull();
		expect(first.hasSession("s_retry")).toBe(true);
		const kept = journal.read().find((e) => e.sessionId === "s_retry")!;
		expect(kept.ttSessionId).toBe(oldTtId);
		expect(kept.overrides).toEqual({ tenantId: "t1" });

		// Next boot: the restore works and the history is back.
		const second = newPool(journal);
		const [r2] = mod.resumeJournaledSessions(journal, second, store);
		expect(r2.toolCallCount).toBe(4);
		expect(second.getAgent("s_retry")!.getMessageHistory().slice(1)).toEqual(history.slice(1));
		expect(journal.read().find((e) => e.sessionId === "s_retry")!.ttSessionId).toBe(
			second.getAgent("s_retry")!.getTimeTravelSessionId(),
		);
	});

	test("a crash during restore, before the fork, still leaves the old checkpoint journaled", () => {
		const journal = new mod.SessionJournal(journalPath);
		journal.upsert({
			sessionId: "s_mid",
			channel: "api",
			ttSessionId: "session_mid_old",
			createdAt: 1,
		});
		const store = new TimeTravelStore({ dataDir: ttDir });
		store.save("session_mid_old", [{ role: "user", content: "x" }], { reason: "manual" });
		// Recreate the session the way resume does, then stop (the "crash").
		const pool = newPool(journal);
		pool.createSession("s_mid", "api", undefined, { journal: false });
		expect(journal.read()[0].ttSessionId).toBe("session_mid_old");
	});

	test("a missing checkpoint blob leaves the session empty instead of failing boot", () => {
		const journal = new mod.SessionJournal(journalPath);
		journal.upsert({
			sessionId: "s_gone",
			channel: "api",
			ttSessionId: "session_gone",
			createdAt: 1,
		});
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

/**
 * #3653: a tool call that was running when the daemon died is not blindly
 * replayed on resume. Reads are re-run; writes, shell, git and network calls
 * are reported to the model as "not replayed, needs confirmation".
 */
describe("replay class", () => {
	test("reads replay, side effects never do, anything unknown asks", async () => {
		const { toolReplayClass } = await import("../eight/tools");
		for (const t of ["read_file", "git_log"]) {
			expect(toolReplayClass(t)).toBe("replay");
		}
		for (const t of [
			"write_file",
			"edit_file",
			"run_command",
			"git_commit",
			"git_push",
			"gh_pr_create",
			"post_message",
			"web_fetch",
			"vercel_deploy",
		]) {
			expect(toolReplayClass(t)).toBe("never");
		}
		expect(toolReplayClass("some_new_tool")).toBe("ask");
	});
});

describe("interrupted tool calls on resume", () => {
	test("pool journals a running tool call and drops it when it ends", () => {
		const journal = new mod.SessionJournal(journalPath);
		const pool = newPool(journal);
		pool.createSession("s_tools", "api");
		const events = (pool.getAgent("s_tools") as any).events;
		events.onToolStart({ toolName: "read_file", toolCallId: "c1", args: { path: "a.txt" } });
		events.onToolStart({
			toolName: "write_file",
			toolCallId: "c2",
			args: { path: "b.txt", content: "x".repeat(5000) },
		});
		const inFlight = journal.read()[0].inFlight!;
		expect(inFlight.map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(inFlight[0].args).toEqual({ path: "a.txt" });
		// A call that will never be replayed keeps only a short summary on disk.
		expect(String(inFlight[1].args.content).length).toBeLessThan(300);
		events.onToolEnd({
			toolName: "read_file",
			toolCallId: "c1",
			args: {},
			success: true,
			durationMs: 1,
		});
		expect(journal.read()[0].inFlight!.map((c) => c.id)).toEqual(["c2"]);
	});

	test("an unfinished read is re-run and an unfinished write is marked, not replayed", async () => {
		fs.writeFileSync(path.join(root, "notes-3653.txt"), "replay me 3653\n");
		const outFile = path.join(root, "out-3653.txt");
		fs.rmSync(outFile, { force: true });
		const journal = new mod.SessionJournal(journalPath);
		journal.upsert({
			sessionId: "s_mid_tool",
			channel: "api",
			ttSessionId: "session_mid_tool",
			createdAt: 1,
			inFlight: [
				{ id: "w1", tool: "write_file", args: { path: "out-3653.txt" }, startedAt: 2 },
				{ id: "r1", tool: "read_file", args: { path: "notes-3653.txt" }, startedAt: 3 },
			],
		});
		const store = new TimeTravelStore({ dataDir: ttDir });
		store.save("session_mid_tool", [{ role: "user", content: "write the notes" }], {
			reason: "interval",
			toolCallCount: 2,
		});

		const pool = newPool(journal);
		mod.resumeJournaledSessions(journal, pool, store);
		const [settled] = await mod.settleInterruptedToolCalls(journal, pool);

		expect(settled.sessionId).toBe("s_mid_tool");
		expect(settled.replayed).toEqual(["r1"]);
		expect(settled.notReplayed).toEqual(["w1"]);
		expect(fs.existsSync(outFile)).toBe(false);

		const history = pool.getAgent("s_mid_tool")!.getMessageHistory();
		const note = history[history.length - 1];
		expect(note.role).toBe("user");
		expect(note.content).toContain("replay me 3653");
		expect(note.content).toContain("write_file");
		expect(note.content).toContain("not replayed, needs confirmation");
		expect(note.content).toContain("out-3653.txt");

		// Settled: a second crash does not report or run them again.
		expect(journal.read()[0].inFlight ?? []).toEqual([]);
		expect(await mod.settleInterruptedToolCalls(journal, pool)).toEqual([]);
	});

	test("malformed in-flight calls are dropped, the session entry is kept", () => {
		fs.mkdirSync(path.dirname(journalPath), { recursive: true });
		fs.writeFileSync(
			journalPath,
			JSON.stringify({
				version: 1,
				sessions: [
					{
						sessionId: "s_bad_calls",
						channel: "api",
						ttSessionId: "session_bad_calls",
						createdAt: 1,
						inFlight: [{ id: "ok", tool: "read_file", args: {}, startedAt: 1 }, { id: 5 }, "x"],
					},
				],
			}),
		);
		const [entry] = new mod.SessionJournal(journalPath).read();
		expect(entry.sessionId).toBe("s_bad_calls");
		expect(entry.inFlight!.map((c) => c.id)).toEqual(["ok"]);
	});
});

/**
 * 8SO review of #3698: the replay set holds only reads that have no side
 * effects and pass the standard path and policy checks, and journal text is
 * scrubbed of secrets.
 */
describe("replay set review (#3653)", () => {
	test("language-server tools are not replayed: starting a server can run project code", async () => {
		const { toolReplayClass } = await import("../eight/tools");
		for (const t of [
			"lsp_goto_definition",
			"lsp_find_references",
			"lsp_hover",
			"lsp_document_symbols",
			"lsp_diagnostics",
		]) {
			expect(toolReplayClass(t)).toBe("ask");
		}
	});

	test("git status and diff are not replayed (repo config can run helpers); git log is", async () => {
		const { toolReplayClass } = await import("../eight/tools");
		expect(toolReplayClass("git_status")).toBe("ask");
		expect(toolReplayClass("git_diff")).toBe("ask");
		expect(toolReplayClass("git_log")).toBe("replay");
	});

	test("only reads with the standard path checks replay, and a replayed read is confined", async () => {
		const { toolReplayClass } = await import("../eight/tools");
		for (const t of ["read_pdf", "read_pdf_page", "search_pdf", "read_notebook", "list_files"]) {
			expect(toolReplayClass(t)).toBe("ask");
		}
		// Args come from disk on resume: a read outside the working directory
		// is refused the same way a live call is.
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside3653-"));
		const secretFile = path.join(outside, "private.txt");
		fs.writeFileSync(secretFile, "outside marker 3653\n");
		const journal = new mod.SessionJournal(journalPath);
		journal.upsert({
			sessionId: "s_escape",
			channel: "api",
			ttSessionId: "session_escape",
			createdAt: 1,
			inFlight: [{ id: "r9", tool: "read_file", args: { path: secretFile }, startedAt: 1 }],
		});
		const pool = newPool(journal);
		mod.resumeJournaledSessions(journal, pool, new TimeTravelStore({ dataDir: ttDir }));
		await mod.settleInterruptedToolCalls(journal, pool);
		const history = pool.getAgent("s_escape")!.getMessageHistory();
		expect(history[history.length - 1].content).not.toContain("outside marker 3653");
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("journal summaries and the harness note are scrubbed of secrets", async () => {
		const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
		expect(token.length).toBe(40);
		const journal = new mod.SessionJournal(journalPath);
		const pool = newPool(journal);
		pool.createSession("s_secret", "api");
		const events = (pool.getAgent("s_secret") as any).events;
		events.onToolStart({
			toolName: "run_command",
			toolCallId: "c9",
			args: { command: `curl -H "Authorization: Bearer ${token}" https://api.github.com` },
		});
		expect(fs.readFileSync(journalPath, "utf8")).not.toContain(token);

		// A journal written by an older build (or by hand) still never shows
		// the secret to the model.
		journal.upsert({
			sessionId: "s_secret2",
			channel: "api",
			ttSessionId: "session_secret2",
			createdAt: 1,
			inFlight: [{ id: "w9", tool: "write_file", args: { path: ".env", content: `TOKEN=${token}` }, startedAt: 1 }],
		});
		const after = newPool(journal);
		mod.resumeJournaledSessions(journal, after, new TimeTravelStore({ dataDir: ttDir }));
		await mod.settleInterruptedToolCalls(journal, after);
		const history = after.getAgent("s_secret2")!.getMessageHistory();
		const note = history[history.length - 1].content;
		expect(note).toContain("not replayed, needs confirmation");
		expect(note).not.toContain(token);
	});
});
