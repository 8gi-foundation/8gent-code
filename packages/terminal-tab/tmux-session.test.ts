/**
 * Tests for tmux-session — orchestration backend that lets 8gent
 * spawn, drive, and read from external CLI sessions running in real
 * Terminal.app windows.
 *
 * Pure command-builder tests run by default. The live tmux integration
 * test runs only when TMUX_INTEGRATION=1 and tmux is on PATH.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SESSION_ENV_ALLOW,
	buildEnterKeyArgs,
	buildPipePaneArgs,
	buildSendKeysArgs,
	buildTmuxNewSessionArgs,
	composeShellCommand,
	hasSession,
	killTmuxSession,
	listTmuxSessions,
	newTmuxRun,
	parseLogTail,
	readSessionLog,
	releaseRun,
	sendKeys,
	sessionEnv,
	sessionShellCommand,
	setTmuxRunForTest,
	spawnTmuxSession,
	thisTmuxRun,
	tmuxArgv,
} from "./tmux-session.js";

const tmuxAvailable = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

// Live tests never touch the real home: this run's socket and owner record
// live in a scratch directory for the whole file, and every log is a temp path.
// Kept short so the socket path fits the unix socket length limit.
const TMP = mkdtempSync(join(tmpdir(), "8t-"));
const realRun = thisTmuxRun();
setTmuxRunForTest(newTmuxRun(join(TMP, "term")));
const tmpLog = (name: string) => join(TMP, `${name}.log`);

/**
 * tmux can start a server here. `tmux -V` alone is not enough: a sandbox may
 * have tmux and still refuse to create a server. Probed on a scratch socket.
 */
const tmuxServes = (() => {
	if (!tmuxAvailable) return false;
	const sock = join(TMP, "probe.sock");
	try {
		execFileSync("tmux", ["-S", sock, "new-session", "-d", "-s", "probe", "sleep 5"], {
			stdio: "ignore",
			timeout: 3000,
		});
		execFileSync("tmux", ["-S", sock, "kill-server"], { stdio: "ignore", timeout: 3000 });
		return true;
	} catch {
		return false;
	} finally {
		rmSync(sock, { force: true });
	}
})();

const live = tmuxServes && process.env.TMUX_INTEGRATION === "1";

describe("buildTmuxNewSessionArgs", () => {
	it("builds detached new-session with size and command", () => {
		const args = buildTmuxNewSessionArgs({
			sessionId: "term-abc",
			command: "claude",
			cmdArgs: [],
			cwd: "/Users/me",
			cols: 200,
			rows: 50,
		});
		expect(args).toContain("new-session");
		expect(args).toContain("-d");
		expect(args).toContain("-s");
		expect(args).toContain("term-abc");
		expect(args).toContain("-x");
		expect(args).toContain("200");
		expect(args).toContain("-y");
		expect(args).toContain("50");
		expect(args).toContain("-c");
		expect(args).toContain("/Users/me");
		expect(args[args.length - 1]).toBe(sessionShellCommand("claude"));
		expect(args[args.length - 1]).toStartWith("exec /usr/bin/env -i ");
	});

	it("appends shell-quoted args when cmdArgs is non-empty", () => {
		const args = buildTmuxNewSessionArgs({
			sessionId: "term-x",
			command: "/bin/sh",
			cmdArgs: ["-c", "echo hi"],
			cwd: "/tmp",
		});
		// Final element is a single shell string with the args glued in.
		const last = args[args.length - 1];
		expect(last).toContain("/bin/sh");
		expect(last).toContain("'-c'");
		expect(last).toContain("'echo hi'");
	});
});

describe("buildSendKeysArgs", () => {
	it("types the text literally with -l and a -- guard", () => {
		expect(buildSendKeysArgs("term-x", "hello world")).toEqual([
			"send-keys",
			"-t",
			"=term-x:",
			"-l",
			"--",
			"hello world",
		]);
	});

	it("keeps key-name text as one literal argument, never a key", () => {
		for (const text of [
			"BSpace",
			"C-u",
			"C-w",
			"Up",
			"Escape",
			"Enter",
			"C-m",
			"-l",
			"-l --",
			"-l -- x",
			"echo hi;",
		]) {
			const args = buildSendKeysArgs("term-x", text);
			expect(args.slice(0, 5)).toEqual(["send-keys", "-t", "=term-x:", "-l", "--"]);
			expect(args).toHaveLength(6);
			expect(args[5]).toBe(text);
		}
	});

	it("never carries Enter in the literal call", () => {
		expect(buildSendKeysArgs("term-x", "x")).not.toContain("Enter");
	});
});

describe("buildEnterKeyArgs", () => {
	it("presses Enter as a key, in its own call", () => {
		expect(buildEnterKeyArgs("term-x")).toEqual(["send-keys", "-t", "=term-x:", "Enter"]);
	});
});

describe("buildPipePaneArgs", () => {
	it("builds pipe-pane to a log file with -o so the pipe is open", () => {
		const args = buildPipePaneArgs("term-x", "/tmp/x.log");
		expect(args[0]).toBe("pipe-pane");
		expect(args).toContain("-t");
		// An exact pane target: never a prefix or pattern match.
		expect(args).toContain("=term-x:");
		expect(args).toContain("-o");
		// Last arg is the shell command "cat >> /tmp/x.log"
		expect(args[args.length - 1]).toContain("/tmp/x.log");
		expect(args[args.length - 1]).toContain(">>");
	});
});

describe("parseLogTail", () => {
	it("returns all lines + the new byte offset on first read", () => {
		const log = "a\nb\nc\n";
		expect(parseLogTail(log, 0)).toEqual({ lines: ["a", "b", "c"], nextOffset: 6 });
	});

	it("returns only new lines when called with a previous offset", () => {
		const log = "a\nb\nc\n";
		// Caller has already consumed bytes 0..2 ("a\n").  Next call returns b,c.
		expect(parseLogTail(log, 2)).toEqual({ lines: ["b", "c"], nextOffset: 6 });
	});

	it("returns no lines when offset is at end-of-log", () => {
		const log = "a\nb\nc\n";
		expect(parseLogTail(log, 6)).toEqual({ lines: [], nextOffset: 6 });
	});

	it("strips ANSI control sequences while keeping printable chars", () => {
		const log = "hello\nworld\x1b[2m·\x1b[22m\n";
		const out = parseLogTail(log, 0);
		expect(out.lines[0]).toBe("hello");
		expect(out.lines[1]).toContain("world");
		expect(out.lines[1]).toContain("·");
	});

	it("ignores trailing partial line so polling never duplicates it", () => {
		const log = "complete\npartial-no-newline";
		const out = parseLogTail(log, 0);
		expect(out.lines).toEqual(["complete"]);
		expect(out.nextOffset).toBe(9); // length of "complete\n"
	});
});

// -------------------------------------------------------
// Live tests: spawn a real tmux session, drive it, kill it
// -------------------------------------------------------

const liveSessions: string[] = [];
afterAll(() => {
	for (const s of liveSessions) {
		try {
			execFileSync("tmux", tmuxArgv(["kill-session", "-t", s]), { stdio: "ignore" });
		} catch {
			/* already gone */
		}
	}
	// Stop this run's own server and drop its socket and owner record.
	try {
		execFileSync("tmux", tmuxArgv(["kill-server"]), { stdio: "ignore" });
	} catch {
		/* no server */
	}
	releaseRun();
	setTmuxRunForTest(realRun);
	rmSync(TMP, { recursive: true, force: true });
});

describe("spawnTmuxSession — live", () => {
	it.if(live)(
		"text spelling a key name is typed literally, not pressed",
		async () => {
			const handle = await spawnTmuxSession({
				command: "/bin/sh",
				args: ["-i"],
				cwd: process.cwd(),
				logPath: tmpLog("keyname"),
			});
			liveSessions.push(handle.sessionId);
			await sendKeys(handle.sessionId, "echo KEYNAME-C-u-BSpace-Up", { appendEnter: false });
			await sendKeys(handle.sessionId, "", { appendEnter: false });
			await sendKeys(handle.sessionId, "C-u", { appendEnter: false });
			await new Promise((r) => setTimeout(r, 600));
			const concat = readSessionLog(handle.logPath, 0).lines.join("\n");
			expect(concat).toContain("echo KEYNAME-C-u-BSpace-Up");
			expect(concat).toContain("C-u");
			await killTmuxSession(handle.sessionId);
		},
		8000,
	);

	it.if(live)(
		"spawns a real tmux session, captures pipe-pane output, send-keys works, kill-session ends it",
		async () => {
			const handle = await spawnTmuxSession({
				command: "/bin/sh",
				args: ["-i"],
				cwd: process.cwd(),
				cols: 100,
				rows: 30,
				logPath: tmpLog("marker"),
			});
			liveSessions.push(handle.sessionId);

			expect(await hasSession(handle.sessionId)).toBe(true);
			expect(handle.pid).toBeGreaterThan(0);
			expect(existsSync(handle.logPath)).toBe(true);

			// Send a marker via send-keys
			await sendKeys(handle.sessionId, "printf MARKER-TMUX-OK");
			// Give tmux a moment to flush pipe-pane to disk
			await new Promise((r) => setTimeout(r, 800));

			const tail = readSessionLog(handle.logPath, 0);
			const concat = tail.lines.join("\n");
			expect(concat).toContain("MARKER-TMUX-OK");
			// tmux appended to the log the app created: still owner only.
			expect(statSync(handle.logPath).mode & 0o777).toBe(0o600);
			// This run's socket and owner record sit in a 0700 directory.
			expect(statSync(thisTmuxRun().dir).mode & 0o777).toBe(0o700);
			expect(existsSync(thisTmuxRun().socketPath)).toBe(true);
			expect(readFileSync(thisTmuxRun().ownerPath, "utf-8")).toBe(`${process.pid}\n`);

			// Kill it
			await killTmuxSession(handle.sessionId);
			await new Promise((r) => setTimeout(r, 200));
			expect(await hasSession(handle.sessionId)).toBe(false);
		},
		8000,
	);
});

// -------------------------------------------------------
// #146: every call goes to the app's own tmux server
// -------------------------------------------------------

describe("private tmux socket", () => {
	it("every tmux argv carries -S and this run's own socket path first", () => {
		const run = thisTmuxRun();
		expect(run.socketPath.endsWith(`${process.pid}-${run.id.split("-")[1]}.sock`)).toBe(true);
		expect(tmuxArgv(["kill-session", "-t", "x"])).toEqual([
			"-S",
			run.socketPath,
			"kill-session",
			"-t",
			"x",
		]);
	});

	if (!tmuxServes) {
		console.log(
			`[tmux-session.test] SKIP real-tmux tests: ${tmuxAvailable ? "tmux is installed but could not start a server here" : "tmux was not found on this machine"}. The fake-runner tests in packages/eight/term-tools-ownership.test.ts still run.`,
		);
	}

	it.if(tmuxServes)(
		"the program in a session sees only the allowlist: no TMUX, TMUX_PANE or socket path",
		async () => {
			const out = tmpLog("env");
			// tmux copies SSH_AUTH_SOCK from the client into a new session by default.
			const saved = process.env.SSH_AUTH_SOCK;
			process.env.SSH_AUTH_SOCK = "/tmp/canary-ssh.sock";
			let id = "";
			try {
				const handle = await spawnTmuxSession({
					command: "sh",
					args: ["-c", `env > '${out}.env'; echo "done=1" >> '${out}.env'; sleep 30`],
					cwd: process.cwd(),
					logPath: out,
				});
				id = handle.sessionId;
				let text = "";
				for (let i = 0; i < 30 && !text.includes("done=1"); i++) {
					await new Promise((r) => setTimeout(r, 100));
					text = existsSync(`${out}.env`) ? readFileSync(`${out}.env`, "utf-8") : "";
				}
				const keys = text
					.split("\n")
					.filter((l) => l.includes("=") && l !== "done=1")
					.map((l) => l.slice(0, l.indexOf("=")));
				expect(keys).toContain("PATH");
				for (const k of keys) expect(ALLOWED.has(k)).toBe(true);
				expect(text).not.toContain("TMUX");
				expect(text).not.toContain(thisTmuxRun().socketPath);
				expect(text).not.toContain("canary");
			} finally {
				if (saved === undefined) Reflect.deleteProperty(process.env, "SSH_AUTH_SOCK");
				else process.env.SSH_AUTH_SOCK = saved;
				if (id) await killTmuxSession(id);
			}
		},
		10000,
	);

	it.if(tmuxServes)(
		"a session on the default tmux server is not listed and cannot be sent to or killed",
		async () => {
			const name = `user-own-${process.pid}-${Date.now().toString(36)}`;
			const onDefault = () => {
				try {
					execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
					return true;
				} catch {
					return false;
				}
			};
			execFileSync("tmux", ["new-session", "-d", "-s", name, "sleep 60"], { stdio: "ignore" });
			let ours = "";
			try {
				expect(onDefault()).toBe(true);
				expect(await listTmuxSessions()).not.toContain(name);
				expect(await hasSession(name)).toBe(false);
				await expect(sendKeys(name, "echo reached")).rejects.toThrow();
				await killTmuxSession(name);
				expect(onDefault()).toBe(true);

				// And a spawned session lives on the private server, not the default one.
				const handle = await spawnTmuxSession({
					command: "sleep",
					args: ["60"],
					cwd: process.cwd(),
					logPath: tmpLog(`${name}-spawn`),
				});
				ours = handle.sessionId;
				expect(await hasSession(ours)).toBe(true);
				expect(await listTmuxSessions()).toContain(ours);
				let onDefaultToo = true;
				try {
					execFileSync("tmux", ["has-session", "-t", ours], { stdio: "ignore" });
				} catch {
					onDefaultToo = false;
				}
				expect(onDefaultToo).toBe(false);
			} finally {
				if (ours) await killTmuxSession(ours);
				try {
					execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
				} catch {
					/* already gone */
				}
			}
		},
		10000,
	);
});

describe("composeShellCommand", () => {
	it("no args passes the command line through as written", () => {
		expect(composeShellCommand("echo hi; ls")).toBe("echo hi; ls");
		expect(composeShellCommand("ls", [])).toBe("ls");
	});

	it("args are single-quoted along with the command", () => {
		expect(composeShellCommand("sh", ["-c", "it's"])).toBe("'sh' '-c' 'it'\\''s'");
	});

	it("buildTmuxNewSessionArgs hands tmux exactly that string", () => {
		for (const [command, cmdArgs] of [
			["echo hi; ls", []],
			["sh", ["-c", "echo $HOME"]],
		] as [string, string[]][]) {
			const argv = buildTmuxNewSessionArgs({ sessionId: "x", command, cmdArgs, cwd: "/" });
			// The judged string, run under an app-made environment wrapper.
			expect(argv[argv.length - 1]).toBe(
				sessionShellCommand(composeShellCommand(command, cmdArgs)),
			);
		}
	});
});

// -------------------------------------------------------
// #146 item 4: a session's program gets an explicit, minimal environment
// -------------------------------------------------------

/** Variables /bin/sh itself may set, besides the ones the wrapper passes. */
const SHELL_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const ALLOWED = new Set<string>([...SESSION_ENV_ALLOW, "TERM", ...SHELL_OWN]);

describe("session environment", () => {
	const run = thisTmuxRun();
	/** The app's own environment as it might be inside the person's tmux, with secrets. */
	const appEnv = {
		...process.env,
		TMUX: `${run.socketPath},4242,0`,
		TMUX_PANE: "%7",
		TMUX_TMPDIR: run.dir,
		EIGHT_CANARY_SECRET: "canary-secret-value",
		SSH_AUTH_SOCK: "/tmp/canary-ssh.sock",
		TMPDIR: join(run.dir, "tmp"),
	};

	it("keeps only the allowlist, and drops any value that names the socket directory", () => {
		const env = sessionEnv(appEnv, run);
		for (const k of Object.keys(env)) expect(SESSION_ENV_ALLOW as readonly string[]).toContain(k);
		expect(env.TMUX).toBeUndefined();
		expect(env.TMUX_PANE).toBeUndefined();
		expect(env.TMPDIR).toBeUndefined();
		expect(env.PATH).toBe(process.env.PATH as string);
		for (const v of Object.values(env)) expect(v).not.toContain(run.dir);
	});

	it("the spawn argv names neither TMUX, TMUX_PANE nor the socket path", () => {
		const argv = buildTmuxNewSessionArgs(
			{ sessionId: "8gent-term-0123456789ab", command: "claude", cwd: "/" },
			sessionEnv(appEnv, run),
		);
		const all = argv.join("\n");
		expect(all).not.toContain("TMUX");
		expect(all).not.toContain(run.socketPath);
		expect(all).not.toContain(run.dir);
		expect(all).not.toContain("canary");
	});

	// Regression for the 8SO read of 3be83b9 and e4afed9: there, the program got
	// the app's whole environment with only TMUX and TMUX_PANE unset. Runs the
	// exact string tmux is given through /bin/sh, the way tmux does, no tmux needed.
	it("the program sees only the allowlist and TERM, never TMUX, TMUX_PANE or a secret", () => {
		const argv = buildTmuxNewSessionArgs(
			{ sessionId: "x", command: "env", cwd: "/" },
			sessionEnv(appEnv, run),
		);
		const out = execFileSync("/bin/sh", ["-c", argv[argv.length - 1]], {
			env: { ...appEnv, TERM: "screen" },
			encoding: "utf-8",
		});
		const keys = out
			.split("\n")
			.filter((l) => l.includes("="))
			.map((l) => l.slice(0, l.indexOf("=")));
		for (const k of keys) expect(ALLOWED.has(k)).toBe(true);
		expect(keys).toContain("TERM");
		expect(keys).toContain("PATH");
		expect(out).not.toContain("TMUX");
		expect(out).not.toContain(run.socketPath);
		expect(out).not.toContain("canary");
	});
});
