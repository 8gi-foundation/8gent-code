/**
 * #4121: System One must take `bash .tmp/serve.sh` without the judge when the
 * script is a file this session wrote under the workspace's own .tmp, and its
 * text binds nothing beyond loopback and reaches nothing outside the
 * workspace. It must pass nothing else. The judge here says "dangerous" to
 * everything, so any command that reaches it is blocked; a negative must never
 * be the allowlist. The record is filled the way write_file fills it: through
 * watchWrite around the real write.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** What the pilot's serve.sh would need to say to pass: the same server, loopback only. */
const LOOPBACK_SERVE = (ws: string) =>
	`#!/bin/sh\ncd ${ws}\nexec python3 -m http.server 8731 --bind 127.0.0.1\n`;

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

const ok = (c: string, record: CreatedFiles | undefined = rec) => runOwnScript(c, ws, record).ok;

// The lane reads POSIX shell text and is off on win32, like the rm/mv lanes.
describe.skipIf(process.platform === "win32")(
	"#4121 running a script this session wrote in .tmp",
	() => {
		beforeEach(() => {
			ws = tempDir("s1-ownscript-ws-");
			outside = tempDir("s1-ownscript-out-");
			// Before the session: a script already in .tmp, and one outside.
			put(".tmp/old.sh", "echo old\n");
			writeFileSync(join(outside, "elsewhere.sh"), "echo elsewhere\n");
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
			test("the pilot's command on a script created this session that binds 127.0.0.1", () => {
				const r = runOwnScript(PILOT_RUN, ws, rec);
				expect(r.ok).toBe(true);
				if (r.ok) expect(r.reason).toContain(".tmp/serve.sh");
			});
			test("each interpreter on a script of its own kind", () => {
				own(".tmp/a.sh", "echo hi\nls .tmp\n");
				own(".tmp/b.py", "print('hi')\n");
				own(".tmp/c.ts", "console.log('hi');\n");
				expect(ok("sh .tmp/a.sh")).toBe(true);
				expect(ok("bash .tmp/a.sh")).toBe(true);
				expect(ok("python3 .tmp/b.py")).toBe(true);
				expect(ok("bun .tmp/c.ts")).toBe(true);
			});
			test("division in python and JavaScript is not the root directory", () => {
				own(".tmp/d.py", "x = [1, 2, 3]\nprint(x[::-1], 10 / 2)\n");
				own(".tmp/d.ts", "// half\nconsole.log(4 / 2);\n");
				expect(ok("python3 .tmp/d.py")).toBe(true);
				expect(ok("bun .tmp/d.ts")).toBe(true);
			});
			test("a script the session rewrote after creating it", () => {
				own(".tmp/serve.sh", `${LOOPBACK_SERVE(ws)}# again\n`);
				expect(ok(PILOT_RUN)).toBe(true);
			});
			test("a python server bound to localhost, and a loopback curl", () => {
				own(
					".tmp/s.py",
					"from http.server import HTTPServer\nHTTPServer(('127.0.0.1', 8731), None)\n",
				);
				own(".tmp/c.sh", "curl -s http://127.0.0.1:8731/index.html -o .tmp/page.html\n");
				expect(ok("python3 .tmp/s.py")).toBe(true);
				expect(ok("bash .tmp/c.sh")).toBe(true);
			});
		});

		describe("runOwnScript refuses", () => {
			test("a script that existed before the session", () => {
				expect(ok("bash .tmp/old.sh")).toBe(false);
			});
			test("an older file renamed onto the session's script (birth time and inode move)", () => {
				renameSync(join(outside, "elsewhere.sh"), join(ws, ".tmp/serve.sh"));
				expect(ok(PILOT_RUN)).toBe(false);
			});
			test("a symlink, even one pointing at the session's own script", () => {
				symlinkSync(join(ws, ".tmp/serve.sh"), join(ws, ".tmp/link.sh"));
				expect(ok("bash .tmp/link.sh")).toBe(false);
			});
			test("a .tmp that is itself a symlink out of the workspace", () => {
				rmSync(join(ws, ".tmp"), { recursive: true, force: true });
				symlinkSync(outside, join(ws, ".tmp"));
				own(".tmp/x.sh", "echo hi\n");
				expect(ok("bash .tmp/x.sh")).toBe(false);
			});
			test("a hard link (nlink 2)", () => {
				linkSync(join(ws, ".tmp/serve.sh"), join(outside, "twin.sh"));
				expect(ok(PILOT_RUN)).toBe(false);
			});
			test("a session-created script outside .tmp", () => {
				own("serve.sh", "echo hi\n");
				expect(ok("bash serve.sh")).toBe(false);
			});
			test("another session's record, or none", () => {
				expect(runOwnScript(PILOT_RUN, ws, new CreatedFiles()).ok).toBe(false);
				expect(runOwnScript(PILOT_RUN, ws, undefined).ok).toBe(false);
			});
			test("no cwd, or a relative one", () => {
				expect(runOwnScript(PILOT_RUN, undefined, rec).ok).toBe(false);
				expect(runOwnScript(PILOT_RUN, ".", rec).ok).toBe(false);
			});
			const shapes: Array<[string, string]> = [
				["extra args", "bash .tmp/serve.sh 8080"],
				["chained with &&", "bash .tmp/serve.sh && ls"],
				["chained with ;", "bash .tmp/serve.sh; ls"],
				["piped", "bash .tmp/serve.sh | cat"],
				["redirected", "bash .tmp/serve.sh > out.txt"],
				["backgrounded", "bash .tmp/serve.sh &"],
				["a -- separator", "bash -- .tmp/serve.sh"],
				["an interpreter flag", "bash -x .tmp/serve.sh"],
				["an env prefix", "FOO=1 bash .tmp/serve.sh"],
				["env as the program", "env bash .tmp/serve.sh"],
				["a .. segment", "bash .tmp/../x.sh"],
				["a .. that leads back in", "bash .tmp/../.tmp/serve.sh"],
				["a ./ prefix", "bash ./.tmp/serve.sh"],
				["an absolute path", `bash ${ws}/.tmp/serve.sh`],
				["a quoted path", 'bash ".tmp/serve.sh"'],
				["a glob", "bash .tmp/serve.*"],
				["a variable", "bash $D/serve.sh"],
				["another interpreter", "zsh .tmp/serve.sh"],
				["a script with no interpreter", ".tmp/serve.sh"],
				["the wrong interpreter for the file", "python3 .tmp/serve.sh"],
				["a line break", "bash .tmp/serve.sh\nls"],
			];
			for (const [why, cmd] of shapes) test(why, () => expect(ok(cmd)).toBe(false));

			const bodies: Array<[string, string, string]> = [
				[
					"the pilot's own serve.sh: http.server binds every interface",
					"s.sh",
					"#!/bin/sh\nexec python3 -m http.server 8731\n",
				],
				["binding 0.0.0.0", "s.sh", "python3 -m http.server 8731 --bind 0.0.0.0\n"],
				[
					"binding ::",
					"s.py",
					"import socket\ns = socket.socket(socket.AF_INET6)\ns.bind(('::', 8731))\n",
				],
				["binding a LAN address", "s.sh", "python3 -m http.server 8731 -b 192.168.1.5\n"],
				[
					"binding all with an empty host",
					"s.py",
					"from http.server import HTTPServer\nHTTPServer(('', 8731), None)\n",
				],
				[
					"Bun.serve with no hostname",
					"s.ts",
					"Bun.serve({ port: 8731, fetch() { return new Response('x'); } });\n",
				],
				[
					"listen with only a port",
					"s.ts",
					"import http from 'node:http';\nhttp.createServer().listen(8731);\n",
				],
				["a netcat listener", "s.sh", "nc -l 127.0.0.1 8731\n"],
				["rm -rf", "s.sh", "rm -rf build\n"],
				["rmtree", "s.py", "import shutil\nshutil.rmtree('build')\n"],
				["sudo", "s.sh", "sudo ls\n"],
				["curl to the internet", "s.sh", "curl -s https://example.com/x -o .tmp/x\n"],
				["wget with a built URL", "s.sh", "wget -q -O .tmp/x\n"],
				[
					"python fetching the internet",
					"s.py",
					"import urllib.request\nurllib.request.urlopen('https://example.com')\n",
				],
				["an absolute path outside the workspace", "s.sh", "cat /etc/passwd\n"],
				["the root directory", "s.py", "import os\nos.listdir('/')\n"],
				["a /tmp path", "s.sh", "ls /tmp\n"],
				["$HOME", "s.sh", "echo x > $HOME/.profile\n"],
				["~", "s.sh", "echo x > ~/.profile\n"],
				["expanduser", "s.py", "import os\nopen(os.path.expanduser('~/x'), 'w')\n"],
				["a shell variable (lines must be literal)", "s.sh", "R=rm\n$R -r build\n"],
				["command substitution", "s.sh", "echo `id`\n"],
				["a line continuation", "s.sh", "r\\\nm -r build\n"],
				["eval", "s.sh", "eval ls\n"],
				["base64", "s.sh", "echo cm0= | base64 -d\n"],
				["subprocess", "s.py", "import subprocess\nsubprocess.run(['ls'])\n"],
				[
					"child_process",
					"s.ts",
					"import { execSync } from 'node:child_process';\nexecSync('ls');\n",
				],
				["dynamic import", "s.ts", "await import('node:' + 'child_process');\n"],
				["a package install", "s.sh", "npx serve .\n"],
				["non-ASCII text", "s.sh", "echo сat\n"],
			];
			for (const [why, file, body] of bodies) {
				test(why, () => {
					own(`.tmp/${file}`, body);
					const interp = file.endsWith(".py") ? "python3" : file.endsWith(".ts") ? "bun" : "bash";
					expect(ok(`${interp} .tmp/${file}`)).toBe(false);
				});
			}
			test("bun with a bunfig.toml or .env in the working directory", () => {
				own(".tmp/c.ts", "console.log('hi');\n");
				put("bunfig.toml", "preload = ['./evil.ts']\n");
				expect(ok("bun .tmp/c.ts")).toBe(false);
				rmSync(join(ws, "bunfig.toml"));
				put(".env", "X=1\n");
				expect(ok("bun .tmp/c.ts")).toBe(false);
			});
			test("the pilot's own serve.sh is refused with a hint that names the fix", () => {
				own(".tmp/serve.sh", `#!/bin/sh\ncd ${ws}\nexec python3 -m http.server 8731\n`);
				const r = runOwnScript(PILOT_RUN, ws, rec);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.hint).toContain("--bind 127.0.0.1");
			});
		});

		describe("systemOneGate with the lane", () => {
			test("runs the pilot's command without asking the judge", async () => {
				const r = await systemOneGate(PILOT_RUN, process.env, ws, rec);
				expect(r.run).toBe(true);
				expect(r.guard?.backend).toBe("allowlist");
				expect(r.guard?.reason).toContain(".tmp/serve.sh");
				expect(judge.asks).toBe(0);
			});
			test("a script that binds every interface goes to the judge, and the block says what would pass", async () => {
				own(".tmp/serve.sh", "#!/bin/sh\nexec python3 -m http.server 8731\n");
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
		 * Ordering: System One only sees a command every earlier layer allowed. A
		 * run the earlier layers refuse (here semicolon chaining, the pilot's own
		 * second refusal) never reaches the lane, through the real tool entry point.
		 */
		describe("ToolExecutor: write_file .tmp/x.sh, then run_command", () => {
			test("the session's own loopback script runs without the judge", async () => {
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
			test("an earlier layer still refuses a chained run first; the lane never overrides it", async () => {
				const ex = new ToolExecutor(ws, "ownscript2");
				await ex.execute("write_file", { path: ".tmp/hello.sh", content: "echo hello\n" });
				const out = await ex.execute("run_command", { command: "bash .tmp/hello.sh; ls" });
				expect(out).toContain("[BLOCKED]");
				expect(out).not.toContain("hello\n");
				expect(judge.asks).toBe(0);
			});
			test("a script that was there before is not the lane's: blocked by the judge", async () => {
				const ex = new ToolExecutor(ws, "ownscript3");
				const out = await ex.execute("run_command", { command: "bash .tmp/old.sh" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(out).not.toContain("old\n");
			});
		});
	},
);
