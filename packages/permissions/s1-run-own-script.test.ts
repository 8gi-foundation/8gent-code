/**
 * #4121: System One must take `bash .tmp/serve.sh` without the judge when the
 * script is a file this session wrote under the workspace's own .tmp, and its
 * text is only allowlisted literal commands that bind nothing beyond loopback
 * and reach nothing outside the workspace. It must pass nothing else. The
 * judge here says "dangerous" to everything, so any command that reaches it
 * is blocked; a negative must never be the allowlist. The record is filled
 * the way write_file fills it: through watchWrite around the real write.
 *
 * The refusal battery below is 8SO's probe list from the hold on #4123: each
 * entry must stay refused against the real function, and the ones where the
 * tool path matters also through the real ToolExecutor.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles, watchWrite } from "./s1-created-files";
import { runOwnScript } from "./s1-run-own-script";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

/** The exact command from the pilot session (run 2026-10-12_224020, seq 26). */
const PILOT_RUN = "bash .tmp/serve.sh";
/** The pilot's serve.sh rewritten to loopback: the one script the battery lets through. */
const LOOPBACK_SERVE = (dir: string) =>
	`#!/bin/sh\ncd ${dir}\nexec python3 -I -m http.server 8731 --bind 127.0.0.1\n`;
/** The pilot's serve.sh as written (seq 24): http.server with no bind listens on every interface. */
const PILOT_SERVE = (dir: string) => `#!/bin/sh\ncd ${dir}\nexec python3 -m http.server 8731\n`;

let ws: string;
let outside: string;
let rec: CreatedFiles;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});
afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

/** Write `rel` the way write_file does: watched by the session's record. */
function own(rel: string, body: string, record = rec) {
	const abs = join(ws, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	const done = watchWrite(abs, record);
	writeFileSync(abs, body);
	done();
}

/** Write `rel` without the record: a file the session did not create. */
function put(rel: string, body: string) {
	mkdirSync(join(ws, rel, ".."), { recursive: true });
	writeFileSync(join(ws, rel), body);
}

/**
 * A calibrated judge, so a command that reaches it really is judged (and,
 * this judge being "always dangerous", blocked) rather than falling back to
 * rules only.
 */
function calibrated(): string {
	const d = tempDir("s1-ownscript-cal-");
	writeFileSync(
		join(d, "stub-stub-model.json"),
		JSON.stringify({
			model: "stub-model",
			backend: "stub",
			temperature: 1,
			bias: 0,
			blockAbove: 0.5,
			escalateBand: [0.35, 0.65],
			fittedOn: "test",
			n: 2,
			heldOut: { recall: 1, falseBlock: 0, accuracy: 1, escalate: 0, method: "leave-one-out" },
		}),
	);
	return d;
}

const ok = (c: string) => runOwnScript(c, ws, rec).ok;

/** 8SO's script-body probes: each written by the session into .tmp/p.sh, then `bash .tmp/p.sh`. */
const BODY_PROBES: Array<[string, (ws: string) => string]> = [
	// here-docs
	["here-doc into a file", () => "cat <<EOF > .tmp/b.sh\nls\nEOF\n"],
	["here-doc into sh", () => "sh <<EOF\nls\nEOF\n"],
	["quoted here-doc", () => "cat <<'EOF'\nls\nEOF\n"],
	// sourcing another file
	[". of another file", () => ". .tmp/other.sh\n"],
	["source of another file", () => "source .tmp/other.sh\n"],
	// exec of a path outside .tmp
	["exec of an absolute program", () => "exec /bin/sh\n"],
	["exec of a relative path up and out", () => "exec ../x\n"],
	["exec of a program not on the list", () => "exec python3 -c print\n"],
	[
		"exec of the server by absolute path",
		() => "exec /usr/bin/python3 -m http.server 8731 --bind 127.0.0.1\n",
	],
	// relative traversal
	["cd ../..", () => "cd ../..\nls\n"],
	["cd ..", () => "cd ..\n"],
	["ls ../..", () => "ls ../..\n"],
	["cd with no argument (goes home)", () => "cd\nls\n"],
	["cd into a symlink out", () => "cd escape\nls\n"],
	// a script that writes a second script and runs it
	["writes a second script and runs it with sh", () => "echo ls > .tmp/b.sh\nsh .tmp/b.sh\n"],
	["writes a second script and runs it with bash", () => "echo ls > .tmp/b.sh\nbash .tmp/b.sh\n"],
	["writes a second script and runs it by path", () => "echo ls > .tmp/b.sh\n.tmp/b.sh\n"],
	["makes a second script executable", () => "echo ls > .tmp/b.sh\nchmod +x .tmp/b.sh\n"],
	// another interpreter inside the shell script
	["python3 -c", () => "python3 -c print\n"],
	["bun -e", () => "bun -e 1\n"],
	["node -e", () => "node -e 1\n"],
	["the server with an extra flag", () => "python3 -m http.server 8731 --bind 127.0.0.1 -d /\n"],
	["the server with no bind (the pilot's own script)", (w) => PILOT_SERVE(w)],
	["the server bound to 0.0.0.0", () => "python3 -m http.server 8731 --bind 0.0.0.0\n"],
	["the server bound to ::", () => "python3 -m http.server 8731 -b ::\n"],
	// 8SO re-review: without -I the served directory is first on sys.path
	["the loopback server without -I", () => "python3 -m http.server 8731 --bind 127.0.0.1\n"],
	[
		"the -I server with an extra flag",
		() => "python3 -I -m http.server 8731 --bind 127.0.0.1 -d /\n",
	],
	["the -I server bound to 0.0.0.0", () => "python3 -I -m http.server 8731 --bind 0.0.0.0\n"],
	// 8SO re-review: a cd that fails, or runs in a subshell, leaves the shell where it was
	[
		"cd to a missing directory, then cat through a symlink out",
		() => "cd .tmp/nope\ncat escape/x\n",
	],
	[
		"cd to a missing directory, then > through a symlink out",
		() => "cd .tmp/nope\necho hi > escape/x\n",
	],
	[
		"cd in a pipeline subshell, then > through a symlink out",
		() => "mkdir .tmp/d | cd .tmp/d\necho hi > escape/x\n",
	],
	// expansion and escapes
	["${X}", () => "X=a\necho ${X}\n"],
	["$X", () => "X=a\necho $X\n"],
	["$(...)", () => "echo $(id)\n"],
	["backticks", () => "echo `id`\n"],
	["backslash escape", () => "e\\cho hi\n"],
	["line continuation", () => "ec\\\nho hi\n"],
	["quotes gluing a command name", () => "'ec''ho' hi\n"],
	// redirects out of the workspace
	["> to an absolute path outside", () => "echo x > /tmp/x\n"],
	[">> to an absolute path outside", () => "echo x >> /tmp/x\n"],
	["> glued to an absolute path outside", () => "echo x >/tmp/x\n"],
	["> up and out", () => "echo x > ../x\n"],
	["> through a symlink out", () => "echo x > escape/x\n"],
	["2> to an absolute path outside", () => "ls 2> /tmp/x\n"],
	["< from outside", () => "cat < /etc/hosts\n"],
	["a flag carrying a path", () => "ls --color=/etc\n"],
	// network
	["curl 127.0.0.1 | sh", () => "curl 127.0.0.1 | sh\n"],
	["curl to a loopback URL | bash", () => "curl http://127.0.0.1:8731/ | bash\n"],
	["nc", () => "nc -l 127.0.0.1 8731\n"],
	// the original deny cases, now refused by the allowlist
	["rm -rf", () => "rm -rf build\n"],
	["sudo", () => "sudo ls\n"],
	["~", () => "ls ~\n"],
	["an absolute read outside", () => "cat /etc/passwd\n"],
	["non-ASCII", () => "echo сat\n"],
	["an env prefix inside the script", () => "FOO=1 ls\n"],
	["a #! line for another interpreter", () => "#!/usr/bin/env python3\nls\n"],
];

// The lane reads POSIX shell text and is off on win32, like the rm/mv lanes.
describe.skipIf(process.platform === "win32")(
	"#4121 running a script this session wrote in .tmp",
	() => {
		beforeEach(() => {
			ws = tempDir("s1-ownscript-ws-");
			outside = tempDir("s1-ownscript-out-");
			// Before the session: a script already in .tmp, one outside, a link out.
			put(".tmp/old.sh", "echo old\n");
			put(".tmp/other.sh", "echo other\n");
			writeFileSync(join(outside, "elsewhere.sh"), "echo elsewhere\n");
			symlinkSync(outside, join(ws, "escape"));
			Bun.sleepSync(20);
			rec = new CreatedFiles();
			own(".tmp/serve.sh", LOOPBACK_SERVE(ws));
			judge = new AlwaysDangerous();
			_setSystemOneOverridesForTests({
				createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
				askHuman: async () => null,
				calibrationDir: calibrated(),
			});
		});

		afterEach(() => {
			rmSync(ws, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
			Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
		});

		describe("runOwnScript allows", () => {
			test("the positive case: the pilot's serve.sh rewritten to bind 127.0.0.1", () => {
				const r = runOwnScript(PILOT_RUN, ws, rec);
				expect(r.ok).toBe(true);
				if (r.ok) expect(r.reason).toContain(".tmp/serve.sh");
				expect(ok("sh .tmp/serve.sh")).toBe(true);
			});
			test("the -I server still passes with a local http package in the served directory (-I ignores it)", () => {
				put("http/__init__.py", "print('shadowed')\n");
				expect(ok(PILOT_RUN)).toBe(true);
			});
			test("a cd that lands inside, then relative paths that stay inside from both places", () => {
				own(".tmp/cd.sh", "cd .tmp\nls\n");
				expect(ok("bash .tmp/cd.sh")).toBe(true);
			});
			test("the rest of the command list, each used once, with in-workspace paths", () => {
				own(
					".tmp/list.sh",
					"mkdir .tmp/out\necho hi > .tmp/out/a.txt\ncat .tmp/out/a.txt\nls .tmp\npwd\nsleep 0\ntrue\n",
				);
				expect(ok("bash .tmp/list.sh")).toBe(true);
			});
		});

		describe("refuses: what the command names", () => {
			const shapes: Array<[string, string]> = [
				["`.tmp/../x`", "bash .tmp/../x.sh"],
				["`.tmp/../.tmp/serve.sh`", "bash .tmp/../.tmp/serve.sh"],
				["a trailing space", "bash .tmp/serve.sh "],
				["a trailing newline", "bash .tmp/serve.sh\n"],
				["a leading space", " bash .tmp/serve.sh"],
				["two spaces", "bash  .tmp/serve.sh"],
				["a `--` prefix", "bash -- .tmp/serve.sh"],
				["an interpreter flag", "bash -x .tmp/serve.sh"],
				["the env-prefix form", "FOO=1 bash .tmp/serve.sh"],
				["env as the program", "env bash .tmp/serve.sh"],
				["a second argument", "bash .tmp/serve.sh 8080"],
				["chained with ;", "bash .tmp/serve.sh; ls"],
				["chained with &&", "bash .tmp/serve.sh && ls"],
				["chained with a newline", "bash .tmp/serve.sh\nls"],
				["piped", "bash .tmp/serve.sh | cat"],
				["redirected", "bash .tmp/serve.sh > out.txt"],
				["backgrounded", "bash .tmp/serve.sh &"],
				["./ prefix", "bash ./.tmp/serve.sh"],
				["an absolute path", `bash ${ws}/.tmp/serve.sh`],
				["a quoted path", 'bash ".tmp/serve.sh"'],
				["a glob", "bash .tmp/serve.*"],
				["a variable", "bash $D/serve.sh"],
				["python3 (cut from the lane)", "python3 .tmp/serve.py"],
				["bun (cut from the lane)", "bun .tmp/serve.ts"],
				["zsh", "zsh .tmp/serve.sh"],
				["no interpreter", ".tmp/serve.sh"],
			];
			for (const [why, cmd] of shapes) test(why, () => expect(ok(cmd)).toBe(false));
			test("python3 and bun on files the session wrote", () => {
				own(".tmp/s.py", "print(1)\n");
				own(".tmp/s.ts", "console.log(1);\n");
				expect(ok("python3 .tmp/s.py")).toBe(false);
				expect(ok("bun .tmp/s.ts")).toBe(false);
			});
			test("a session-written script outside .tmp", () => {
				own("serve.sh", "echo hi\n");
				expect(ok("bash serve.sh")).toBe(false);
			});
			test("another session's record, or none; no cwd or a relative one", () => {
				expect(runOwnScript(PILOT_RUN, ws, new CreatedFiles()).ok).toBe(false);
				expect(runOwnScript(PILOT_RUN, ws, undefined).ok).toBe(false);
				expect(runOwnScript(PILOT_RUN, undefined, rec).ok).toBe(false);
				expect(runOwnScript(PILOT_RUN, ".", rec).ok).toBe(false);
			});
		});

		describe("refuses: which file it is", () => {
			test("a script that existed before the session", () => {
				expect(ok("bash .tmp/old.sh")).toBe(false);
			});
			test("rename-in of an older file onto the session's script", () => {
				renameSync(join(outside, "elsewhere.sh"), join(ws, ".tmp/serve.sh"));
				expect(ok(PILOT_RUN)).toBe(false);
			});
			test("a hard link to an older file", () => {
				linkSync(join(outside, "elsewhere.sh"), join(ws, ".tmp/linked.sh"));
				expect(ok("bash .tmp/linked.sh")).toBe(false);
			});
			test("a hard link out of the session's own script (nlink 2)", () => {
				linkSync(join(ws, ".tmp/serve.sh"), join(outside, "twin.sh"));
				expect(ok(PILOT_RUN)).toBe(false);
			});
			test("truncate-and-rewrite after the record, same text", () => {
				Bun.sleepSync(20);
				writeFileSync(join(ws, ".tmp/serve.sh"), "");
				writeFileSync(join(ws, ".tmp/serve.sh"), LOOPBACK_SERVE(ws));
				expect(ok(PILOT_RUN)).toBe(false);
			});
			// macOS only: APFS moves the birth time back when mtime is set earlier,
			// which is how a file older than this process is made here (Linux cannot).
			test.skipIf(process.platform !== "darwin")(
				"a file the record vouches for but born before this process started",
				() => {
					own(".tmp/aged.sh", "echo hi\n");
					const abs = join(ws, ".tmp/aged.sh");
					utimesSync(abs, new Date("2020-01-01"), new Date("2020-01-01"));
					rec.record(abs);
					expect(rec.createdBySession(abs)).toBe(true);
					expect(ok("bash .tmp/aged.sh")).toBe(false);
				},
			);
			test("a symlink, even to the session's own script", () => {
				symlinkSync(join(ws, ".tmp/serve.sh"), join(ws, ".tmp/link.sh"));
				expect(ok("bash .tmp/link.sh")).toBe(false);
			});
			test(".tmp itself a symlink out of the workspace", () => {
				rmSync(join(ws, ".tmp"), { recursive: true, force: true });
				symlinkSync(outside, join(ws, ".tmp"));
				own(".tmp/x.sh", "echo hi\n");
				expect(ok("bash .tmp/x.sh")).toBe(false);
			});
		});

		describe("refuses: what the script says", () => {
			for (const [why, body] of BODY_PROBES) {
				test(why, () => {
					own(".tmp/p.sh", body(ws));
					expect(ok("bash .tmp/p.sh")).toBe(false);
				});
			}
			test("the non -I server is refused while a local http package sits in the served directory", () => {
				put("http/__init__.py", "print('shadowed')\n");
				own(
					".tmp/serve.sh",
					`#!/bin/sh\ncd ${ws}\nexec python3 -m http.server 8731 --bind 127.0.0.1\n`,
				);
				const r = runOwnScript(PILOT_RUN, ws, rec);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.hint).toContain("python3 -I -m http.server");
			});
			test("the pilot's own serve.sh is refused with a hint that names the fix", () => {
				own(".tmp/serve.sh", PILOT_SERVE(ws));
				const r = runOwnScript(PILOT_RUN, ws, rec);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.hint).toContain("--bind 127.0.0.1");
			});
		});

		describe("systemOneGate with the lane", () => {
			test("runs the positive case without asking the judge", async () => {
				const r = await systemOneGate(PILOT_RUN, process.env, ws, rec);
				expect(r.run).toBe(true);
				expect(r.guard?.backend).toBe("allowlist");
				expect(r.guard?.reason).toContain(".tmp/serve.sh");
				expect(judge.asks).toBe(0);
			});
			test("the pilot's own script goes to the judge, and the block says what would pass", async () => {
				own(".tmp/serve.sh", PILOT_SERVE(ws));
				const r = await systemOneGate(PILOT_RUN, process.env, ws, rec);
				expect(r.run).toBe(false);
				expect(r.guard?.backend).not.toBe("allowlist");
				expect(judge.asks).toBe(1);
				if (!r.run) expect(r.message).toContain("--bind 127.0.0.1");
			});
			test("a pre-existing script goes to the judge", async () => {
				const r = await systemOneGate("bash .tmp/old.sh", process.env, ws, rec);
				expect(r.guard?.backend).not.toBe("allowlist");
				expect(judge.asks).toBe(1);
			});
			test("strict mode (Guarded) never uses the lane", async () => {
				process.env[SYSTEM_ONE_FLAG] = "1";
				const r = await systemOneGate(PILOT_RUN, process.env, ws, rec);
				expect(r.run).toBe(false);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
			test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
				process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
				const r = await systemOneGate(PILOT_RUN, process.env, ws, rec);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
			test("without the session's record the lane has no opinion", async () => {
				const r = await systemOneGate(PILOT_RUN, process.env, ws);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
		});

		/**
		 * The real tool entry point: write_file records the script, run_command
		 * goes through every earlier layer and then System One. Each refused probe
		 * would leave .tmp/pwned.txt if it ran; it must not exist afterwards.
		 */
		describe("ToolExecutor: write_file .tmp/x.sh, then run_command", () => {
			const PWNED = ".tmp/pwned.txt";
			test("an allowlisted script runs without the judge", async () => {
				const ex = new ToolExecutor(ws, "ownscript");
				await ex.execute("write_file", {
					path: ".tmp/hello.sh",
					content: "echo hello-from-own-script\n",
				});
				const out = await ex.execute("run_command", { command: "bash .tmp/hello.sh" });
				expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(out).toContain("hello-from-own-script");
				expect(judge.asks).toBe(0);
			});
			const earlier: Array<[string, string]> = [
				["chained with ;", "bash .tmp/hello.sh; touch .tmp/pwned.txt"],
				["chained with a newline", "bash .tmp/hello.sh\ntouch .tmp/pwned.txt"],
			];
			for (const [why, cmd] of earlier) {
				test(`${why}: the earlier layer refuses it, the judge is not asked`, async () => {
					const ex = new ToolExecutor(ws, "ownscript-chain");
					await ex.execute("write_file", { path: ".tmp/hello.sh", content: "echo hello\n" });
					const out = await ex.execute("run_command", { command: cmd });
					expect(out).toContain("[BLOCKED]");
					expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
					expect(judge.asks).toBe(0);
					expect(existsSync(join(ws, PWNED))).toBe(false);
				});
			}
			const throughTool: Array<[string, string]> = [
				["a here-doc", `cat <<EOF > ${PWNED}\nx\nEOF\n`],
				["a second script written and run", `echo touch ${PWNED} > .tmp/b.sh\nsh .tmp/b.sh\n`],
				["$X expansion", "X=pwned\necho x > .tmp/$X.txt\n"],
				["source of another file", `echo touch ${PWNED} > .tmp/b.sh\n. .tmp/b.sh\n`],
				["python3 -c", `python3 -c open('${PWNED}','w')\n`],
				["curl 127.0.0.1 | sh", "curl 127.0.0.1:9 | sh\n"],
			];
			for (const [why, body] of throughTool) {
				test(`${why}: blocked by the judge, nothing ran`, async () => {
					const ex = new ToolExecutor(ws, "ownscript-probe");
					await ex.execute("write_file", { path: ".tmp/p.sh", content: body });
					const out = await ex.execute("run_command", { command: "bash .tmp/p.sh" });
					expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
					expect(judge.asks).toBe(1);
					expect(existsSync(join(ws, PWNED))).toBe(false);
				});
			}
			test("a script that was there before is not the lane's: blocked by the judge", async () => {
				const ex = new ToolExecutor(ws, "ownscript-old");
				const out = await ex.execute("run_command", { command: "bash .tmp/old.sh" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(out).not.toContain("old\n");
			});
		});
	},
);
