/**
 * #146: the term_* tools reach only sessions term_spawn started in this run,
 * on the app's own tmux server, and those sessions end when the app quits.
 * Every test here uses a fake tmux, so none needs tmux installed. The
 * real-tmux check of the private socket is in
 * packages/terminal-tab/tmux-session.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun's mock.module outlives this file: keep the real barrel and put it back afterwards.
const realTerminalTab = { ...(await import("../terminal-tab/index.js")) };
const savedApprove = process.env.EIGHT_HEADLESS_APPROVE;
const savedHeadless = process.env.EIGHT_HEADLESS;
beforeAll(() => {
	process.env.EIGHT_HEADLESS_APPROVE = "1";
	process.env.EIGHT_HEADLESS = "1";
});
afterAll(() => {
	if (savedApprove === undefined) delete process.env.EIGHT_HEADLESS_APPROVE;
	else process.env.EIGHT_HEADLESS_APPROVE = savedApprove;
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
	mock.module("../terminal-tab/index.js", () => realTerminalTab);
	rmSync(TMP, { recursive: true, force: true });
});

/** Scratch state: sockets, owner records and logs live here, never in the real home. */
const TMP = mkdtempSync(join(tmpdir(), "term-own-"));
const SOCK_DIR = join(TMP, "term");
const LOG_DIR = join(TMP, "sessions");
/** The run these tests act as (run B when two runs are compared). */
const runB = realTerminalTab.newTmuxRun(SOCK_DIR, process.pid);
const mode = (p: string) => statSync(p).mode & 0o777;

/** Every call that would have reached tmux, as [operation, target]. */
const tmuxCalls: string[][] = [];
const spawnedTargets: string[] = [];
let tmuxPresent = true;
let liveNames: string[] = [];
/** What the fake tmux says about has-session: false once the program inside has exited. */
let programRunning = true;

mock.module("../terminal-tab/index.js", () => ({
	attachInTerminal: async () => {},
	composeShellCommand: realTerminalTab.composeShellCommand,
	deleteSession: () => {},
	hasTmuxSession: async (id: string) => {
		tmuxCalls.push(["has-session", id]);
		return programRunning;
	},
	isTmuxAvailable: () => tmuxPresent,
	killTmuxSession: async (id: string) => {
		tmuxCalls.push(["kill-session", id]);
	},
	listTmuxSessions: async () => {
		tmuxCalls.push(["list-sessions"]);
		return liveNames;
	},
	readSessionLog: () => ({ lines: [], nextOffset: 0 }),
	saveSession: () => {},
	sendTmuxKeys: async (id: string) => {
		tmuxCalls.push(["send-keys", id]);
	},
	realTmuxSync: () => "",
	releaseRun: realTerminalTab.releaseRun,
	removeSessionLog: realTerminalTab.removeSessionLog,
	sweepDeadRuns: () => [],
	sweepSessionLogs: () => ({ deleted: [], tightened: [] }),
	thisTmuxRun: () => runB,
	tmuxArgv: (args: string[], run = runB) => realTerminalTab.tmuxArgv(args, run),
	spawnTmuxSession: async (o: { command: string; args?: string[]; sessionId: string }) => {
		spawnedTargets.push(o.sessionId);
		// The real log creation, in the scratch directory.
		realTerminalTab.ensurePrivateDir(LOG_DIR);
		const logPath = join(LOG_DIR, `${o.sessionId}.log`);
		realTerminalTab.createSessionLog(logPath);
		realTerminalTab.claimRun(runB);
		return {
			sessionId: o.sessionId,
			command: o.command,
			args: o.args ?? [],
			pid: 1,
			cwd: "/",
			startedAt: new Date().toISOString(),
			logPath,
		};
	},
}));

import {
	type ExitHost,
	endOwnedSessions,
	endSessionsOnExit,
	executeTermTool,
	ownedSessions,
} from "./term-tools";

const SOCKET = ["-S", runB.socketPath];

async function spawn(extra: Record<string, unknown> = {}): Promise<string> {
	const out = JSON.parse(await executeTermTool("term_spawn", { command: "cat", ...extra }));
	expect(out.ok).toBe(true);
	return out.sessionId;
}

/** A fake synchronous tmux that answers list-sessions with `left`. */
function fakeRunner(left: string) {
	const argvs: string[][] = [];
	const run = (argv: string[]) => {
		argvs.push(argv);
		return argv.includes("list-sessions") ? left : "";
	};
	return { argvs, run };
}

beforeEach(() => {
	endOwnedSessions(() => "");
	tmuxCalls.length = 0;
	spawnedTargets.length = 0;
	tmuxPresent = true;
	liveNames = [];
	programRunning = true;
});

describe("term_spawn names its own sessions", () => {
	test("the tmux target is app made; a model-supplied name or label never becomes it", async () => {
		const id = await spawn({ label: "my-shell", sessionId: "my-shell", name: "my-shell" });
		expect(id).toMatch(/^8gent-term-[0-9a-f]{12}$/);
		expect(spawnedTargets).toEqual([id]);
		expect(ownedSessions().map((s) => [s.target, s.label])).toEqual([[id, "my-shell"]]);
		expect(await spawn()).not.toBe(id);
	});
});

describe("only sessions this run started are reachable", () => {
	const userSession = "work";

	test("term_send to an unknown session name is refused and nothing is sent", async () => {
		await spawn();
		const out = await executeTermTool("term_send", { sessionId: userSession, text: "ls" });
		expect(out).toContain("[BLOCKED]");
		expect(out).toContain("Nothing was sent");
		expect(tmuxCalls).toEqual([]);
	});

	test("term_kill refuses a session it did not start", async () => {
		await spawn();
		const out = await executeTermTool("term_kill", { sessionId: userSession });
		expect(out).toContain("[BLOCKED]");
		expect(tmuxCalls).toEqual([]);
	});

	test("term_read refuses a session it did not start", async () => {
		const out = await executeTermTool("term_read", { sessionId: userSession });
		expect(out).toContain("[BLOCKED]");
		expect(tmuxCalls).toEqual([]);
	});

	test("tmux target syntax, patterns and prefixes are refused before any tmux call", async () => {
		const id = await spawn();
		tmuxCalls.length = 0;
		const tries = [
			`${id}:0`,
			`${id}.0`,
			`${id}:0.1`,
			`=${id}`,
			"8gent-term-*",
			`${id}*`,
			` ${id}`,
			`${id} `,
			`${id}\n`,
			id.slice(0, -1),
			"8gent-term-",
			`${id}x`,
			"",
		];
		for (const sessionId of tries) {
			for (const tool of ["term_send", "term_read", "term_kill"]) {
				const out = await executeTermTool(tool, { sessionId, text: "ls" });
				expect(out).toMatch(/^(\[BLOCKED\]|ERR: term_\w+ needs sessionId)/);
			}
		}
		for (const sessionId of [42, null, { id }, [id]]) {
			expect(await executeTermTool("term_send", { sessionId, text: "ls" })).toMatch(/^ERR/);
		}
		expect(tmuxCalls).toEqual([]);
		// The exact target still works.
		expect(await executeTermTool("term_send", { sessionId: id, text: "ls" })).toContain(
			'"ok":true',
		);
	});

	test("term_list returns only the sessions this run started", async () => {
		const id = await spawn({ label: "mine" });
		liveNames = [userSession, id, "8gent-term-000000000000"];
		const out = JSON.parse(await executeTermTool("term_list", {}));
		expect(out.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([id]);
	});

	test("after term_kill the id is refused", async () => {
		const id = await spawn();
		expect(await executeTermTool("term_kill", { sessionId: id })).toContain('"killed":true');
		expect(await executeTermTool("term_send", { sessionId: id, text: "ls" })).toContain(
			"[BLOCKED]",
		);
	});
});

describe("quitting ends the sessions this run started", () => {
	test("cleanup kills each registered session on this run's socket, then stops this run's server", async () => {
		const a = await spawn();
		const b = await spawn();
		const { argvs, run } = fakeRunner("");
		endOwnedSessions(run);
		expect(argvs).toEqual([
			[...SOCKET, "kill-session", "-t", a],
			[...SOCKET, "kill-session", "-t", b],
			[...SOCKET, "kill-server"],
		]);
		expect(ownedSessions()).toEqual([]);
		expect(existsSync(runB.ownerPath)).toBe(false);
		expect(await executeTermTool("term_send", { sessionId: a, text: "ls" })).toContain("[BLOCKED]");
	});

	test("a failing tmux does not stop the rest of the cleanup", async () => {
		const a = await spawn();
		const b = await spawn();
		const argvs: string[][] = [];
		endOwnedSessions((argv) => {
			argvs.push(argv);
			throw new Error("no server");
		});
		expect(argvs.map((x) => x.slice(2, 5))).toEqual([
			["kill-session", "-t", a],
			["kill-session", "-t", b],
			["kill-server"],
		]);
		expect(ownedSessions()).toEqual([]);
	});

	test("with nothing registered, cleanup calls no tmux at all", () => {
		const { argvs, run } = fakeRunner("");
		endOwnedSessions(run);
		expect(argvs).toEqual([]);
	});

	test("exit, SIGINT, SIGTERM and SIGHUP each run the cleanup and the signal still ends the process", () => {
		const listeners = new Map<string, Set<() => void>>();
		const raised: string[] = [];
		const host: ExitHost = {
			pid: 4242,
			on: (e, fn) => {
				if (!listeners.has(e)) listeners.set(e, new Set());
				listeners.get(e)?.add(fn);
			},
			removeListener: (e, fn) => listeners.get(e)?.delete(fn),
			listenerCount: (e) => listeners.get(e)?.size ?? 0,
			kill: (_pid, sig) => raised.push(sig),
		};
		let runs = 0;
		endSessionsOnExit(() => runs++, host);
		for (const e of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
			for (const fn of [...(listeners.get(e) ?? [])]) fn();
		}
		expect(runs).toBe(4);
		expect(raised).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
	});
});

describe("no tmux on the machine", () => {
	test("the tools say the feature is unavailable and never suggest an install", async () => {
		tmuxPresent = false;
		for (const tool of ["term_spawn", "term_send", "term_list"]) {
			const out = await executeTermTool(tool, { command: "cat", sessionId: "x", text: "ls" });
			expect(out).toContain("unavailable");
			expect(out).not.toMatch(/install|brew|apt|dnf|pacman/i);
		}
		expect(spawnedTargets).toEqual([]);
	});
});

// N1: one tmux socket per app run. Two runs, A and B, share a state directory.
describe("one tmux socket per run", () => {
	/** A process id that no longer exists: a child that has already exited. */
	const deadPid = (() => {
		const p = Bun.spawnSync(["true"]);
		return p.pid;
	})();
	/** Lay down a run's socket file and owner record, as a live run would have. */
	function layDown(run: ReturnType<typeof realTerminalTab.newTmuxRun>, owner?: string): void {
		realTerminalTab.ensurePrivateDir(run.dir);
		writeFileSync(run.socketPath, "");
		if (owner !== undefined) writeFileSync(run.ownerPath, owner);
	}

	test("two runs get different sockets, each named for its run, under a 0700 directory", () => {
		const a = realTerminalTab.newTmuxRun(SOCK_DIR, 4100);
		const b = realTerminalTab.newTmuxRun(SOCK_DIR, 4100);
		expect(a.socketPath).not.toBe(b.socketPath);
		expect(a.id).toMatch(/^4100-[0-9a-f]{8}$/);
		expect(a.socketPath).toBe(join(SOCK_DIR, `${a.id}.sock`));
		expect(realTerminalTab.tmuxArgv(["ls"], a)).toEqual(["-S", a.socketPath, "ls"]);
		// The default run is this process's own.
		const self = realTerminalTab.thisTmuxRun();
		expect(self.id.startsWith(`${process.pid}-`)).toBe(true);
		expect(realTerminalTab.tmuxArgv(["ls"])).toEqual(["-S", self.socketPath, "ls"]);
		realTerminalTab.claimRun(a);
		expect(mode(SOCK_DIR)).toBe(0o700);
		expect(mode(a.ownerPath)).toBe(0o600);
		expect(readFileSync(a.ownerPath, "utf-8")).toBe("4100\n");
		realTerminalTab.releaseRun(a);
	});

	test("run B's exit cleanup and startup sweep do not touch run A's live socket", async () => {
		const runA = realTerminalTab.newTmuxRun(SOCK_DIR, process.pid);
		layDown(runA, `${process.pid}\n`);
		await spawn();
		const { argvs, run } = fakeRunner("");
		endOwnedSessions(run);
		expect(argvs.length).toBeGreaterThan(0);
		for (const argv of argvs) {
			expect(argv.slice(0, 2)).toEqual(["-S", runB.socketPath]);
			expect(argv).not.toContain(runA.socketPath);
		}
		expect(existsSync(runA.socketPath)).toBe(true);
		expect(existsSync(runA.ownerPath)).toBe(true);

		const sweepCalls: string[][] = [];
		const swept = realTerminalTab.sweepDeadRuns(
			SOCK_DIR,
			(argv) => {
				sweepCalls.push(argv);
				return "";
			},
			realTerminalTab.isPidAlive,
			runB,
		);
		expect(swept).toEqual([]);
		expect(sweepCalls).toEqual([]);
		expect(existsSync(runA.socketPath)).toBe(true);
		expect(existsSync(runA.ownerPath)).toBe(true);
		realTerminalTab.releaseRun(runA);
	});

	test("a socket whose recorded process is gone is swept: its server stopped, files removed", () => {
		const dead = realTerminalTab.newTmuxRun(SOCK_DIR, deadPid);
		layDown(dead, `${deadPid}\n`);
		expect(realTerminalTab.isPidAlive(deadPid)).toBe(false);
		const calls: string[][] = [];
		const swept = realTerminalTab.sweepDeadRuns(
			SOCK_DIR,
			(argv) => {
				calls.push(argv);
				return "";
			},
			realTerminalTab.isPidAlive,
			runB,
		);
		expect(swept).toEqual([dead.id]);
		expect(calls).toEqual([["-S", dead.socketPath, "kill-server"]]);
		expect(existsSync(dead.socketPath)).toBe(false);
		expect(existsSync(dead.ownerPath)).toBe(false);
	});

	test("a missing, unreadable or malformed owner record is left alone", () => {
		const missing = realTerminalTab.newTmuxRun(SOCK_DIR, deadPid);
		layDown(missing);
		const garbled = realTerminalTab.newTmuxRun(SOCK_DIR, deadPid);
		layDown(garbled, "not a pid");
		const mismatched = realTerminalTab.newTmuxRun(SOCK_DIR, deadPid);
		layDown(mismatched, `${deadPid + 1}\n`);
		const unreadable = realTerminalTab.newTmuxRun(SOCK_DIR, deadPid);
		layDown(unreadable);
		// A directory where the record should be cannot be read as one.
		realTerminalTab.ensurePrivateDir(unreadable.ownerPath);
		const calls: string[][] = [];
		const swept = realTerminalTab.sweepDeadRuns(
			SOCK_DIR,
			(argv) => {
				calls.push(argv);
				return "";
			},
			() => false,
			runB,
		);
		expect(swept).toEqual([]);
		expect(calls).toEqual([]);
		for (const r of [missing, garbled, mismatched, unreadable]) {
			expect(existsSync(r.socketPath)).toBe(true);
		}
		for (const r of [missing, garbled, mismatched, unreadable]) {
			rmSync(r.socketPath, { force: true });
			rmSync(r.ownerPath, { recursive: true, force: true });
		}
	});

	test("the sweep never removes this run's own socket", () => {
		layDown(runB, `${deadPid}\n`);
		expect(
			realTerminalTab.sweepDeadRuns(
				SOCK_DIR,
				() => "",
				() => false,
				runB,
			),
		).toEqual([]);
		expect(existsSync(runB.socketPath)).toBe(true);
		realTerminalTab.releaseRun(runB);
	});
});

// 9: session logs hold whatever the terminal echoed.
describe("session logs", () => {
	const logOf = (id: string) => ownedSessions().find((s) => s.target === id)?.logPath ?? "missing";

	test("a log is created 0600 inside a 0700 directory", async () => {
		const id = await spawn();
		expect(mode(logOf(id))).toBe(0o600);
		expect(mode(LOG_DIR)).toBe(0o700);
	});

	test("a pre-existing looser log and directory are tightened on create", () => {
		const dir = join(TMP, "loose");
		realTerminalTab.ensurePrivateDir(dir);
		chmodSync(dir, 0o755);
		const p = join(dir, "x.log");
		writeFileSync(p, "old");
		chmodSync(p, 0o644);
		realTerminalTab.ensurePrivateDir(dir);
		realTerminalTab.createSessionLog(p);
		expect(mode(dir)).toBe(0o700);
		expect(mode(p)).toBe(0o600);
		expect(readFileSync(p, "utf-8")).toBe("old");
	});

	test("the log is kept while the session lives, even after the program inside exits", async () => {
		const id = await spawn();
		const p = logOf(id);
		await executeTermTool("term_send", { sessionId: id, text: "ls" });
		await executeTermTool("term_read", { sessionId: id });
		await executeTermTool("term_list", {});
		expect(existsSync(p)).toBe(true);
		programRunning = false;
		expect(await executeTermTool("term_send", { sessionId: id, text: "ls" })).toContain(
			"not running",
		);
		expect(JSON.parse(await executeTermTool("term_read", { sessionId: id })).stillRunning).toBe(
			false,
		);
		expect(existsSync(p)).toBe(true);
	});

	test("term_kill deletes the log", async () => {
		const id = await spawn();
		const p = logOf(id);
		expect(existsSync(p)).toBe(true);
		await executeTermTool("term_kill", { sessionId: id });
		expect(existsSync(p)).toBe(false);
	});

	test("app exit deletes every session's log", async () => {
		const a = logOf(await spawn());
		const b = logOf(await spawn());
		endOwnedSessions(() => "");
		expect(existsSync(a)).toBe(false);
		expect(existsSync(b)).toBe(false);
	});

	test("only a regular file is ever removed as a log", () => {
		const dir = join(TMP, "notalog");
		realTerminalTab.ensurePrivateDir(dir);
		realTerminalTab.removeSessionLog(dir);
		realTerminalTab.removeSessionLog("/dev/null");
		expect(existsSync(dir)).toBe(true);
		expect(existsSync("/dev/null")).toBe(true);
	});

	test("startup age sweep: over 30 days deleted, loose and younger tightened, the rest untouched", () => {
		const dir = join(TMP, "sweep");
		realTerminalTab.ensurePrivateDir(dir);
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		const make = (name: string, perm: number, ageDays: number) => {
			const p = join(dir, name);
			writeFileSync(p, "secret");
			chmodSync(p, perm);
			const t = (now - ageDays * day) / 1000;
			utimesSync(p, t, t);
			return p;
		};
		const oldLoose = make("old-loose.log", 0o644, 31);
		const oldTight = make("old-tight.log", 0o600, 40);
		const youngLoose = make("young-loose.log", 0o644, 2);
		const youngTight = make("young-tight.log", 0o600, 29);
		const notLog = make("s.json", 0o644, 90);
		const out = realTerminalTab.sweepSessionLogs(dir, now);
		expect(out.deleted.sort()).toEqual(["old-loose.log", "old-tight.log"]);
		expect(out.tightened).toEqual(["young-loose.log"]);
		expect(existsSync(oldLoose)).toBe(false);
		expect(existsSync(oldTight)).toBe(false);
		expect(mode(youngLoose)).toBe(0o600);
		expect(mode(youngTight)).toBe(0o600);
		expect(existsSync(notLog)).toBe(true);
		expect(mode(notLog)).toBe(0o644);
	});
});
