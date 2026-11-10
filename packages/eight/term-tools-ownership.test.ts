/**
 * #146: the term_* tools reach only sessions term_spawn started in this run,
 * on the app's own tmux server, and those sessions end when the app quits.
 * Every test here uses a fake tmux, so none needs tmux installed. The
 * real-tmux check of the private socket is in
 * packages/terminal-tab/tmux-session.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
});

/** Every call that would have reached tmux, as [operation, target]. */
const tmuxCalls: string[][] = [];
const spawnedTargets: string[] = [];
let tmuxPresent = true;
let liveNames: string[] = [];

mock.module("../terminal-tab/index.js", () => ({
	attachInTerminal: async () => {},
	composeShellCommand: realTerminalTab.composeShellCommand,
	deleteSession: () => {},
	hasTmuxSession: async (id: string) => {
		tmuxCalls.push(["has-session", id]);
		return true;
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
	tmuxArgv: realTerminalTab.tmuxArgv,
	spawnTmuxSession: async (o: { command: string; args?: string[]; sessionId: string }) => {
		spawnedTargets.push(o.sessionId);
		return {
			sessionId: o.sessionId,
			command: o.command,
			args: o.args ?? [],
			pid: 1,
			cwd: "/",
			startedAt: new Date().toISOString(),
			logPath: "/dev/null",
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

const SOCKET = ["-L", realTerminalTab.TMUX_SOCKET_NAME];

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
	test("cleanup kills each registered session on the private socket, then stops an empty server", async () => {
		const a = await spawn();
		const b = await spawn();
		const { argvs, run } = fakeRunner("");
		endOwnedSessions(run);
		expect(argvs).toEqual([
			[...SOCKET, "kill-session", "-t", a],
			[...SOCKET, "kill-session", "-t", b],
			[...SOCKET, "list-sessions", "-F", "#{session_name}"],
			[...SOCKET, "kill-server"],
		]);
		expect(ownedSessions()).toEqual([]);
		expect(await executeTermTool("term_send", { sessionId: a, text: "ls" })).toContain("[BLOCKED]");
	});

	test("the server is left running when it still has sessions (another run's)", async () => {
		await spawn();
		const { argvs, run } = fakeRunner("8gent-term-aaaaaaaaaaaa\n");
		endOwnedSessions(run);
		expect(argvs.some((a) => a.includes("kill-server"))).toBe(false);
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
			["list-sessions", "-F", "#{session_name}"],
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
