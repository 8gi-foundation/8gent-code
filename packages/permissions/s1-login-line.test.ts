/**
 * #4072: System One must take the login-note recipe (`sed -n 's/^Password: *\/password=/w
 * .tmp/login' FILE`) without the judge, and must pass nothing that is not exactly that
 * shape over a regular workspace file into a plain-named file under .tmp/. The judge here
 * says "dangerous" to everything, so any command that reaches it is blocked; a negative
 * must never be the allowlist.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { LOCAL_LOGIN_NOTE } from "../eight/prompts/system-prompt";
import { loginLineToTmp } from "./s1-login-line";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
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

/** The exact command from the pilot session (run 2026-10-12_172356, seq 74 and 82). */
const PILOT_CMD = "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt";
const TASK =
	"Local dashboard\n\nAddress:  http://127.0.0.1:1/\nUsername: pilot-x\nPassword: yGfoi4qmTmGEvy\n\nThe toggle is off.\n";

let ws: string;
let outside: string;
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

function put(rel: string, body = "x", root = ws) {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

beforeEach(() => {
	ws = tempDir("s1-login-ws-");
	outside = tempDir("s1-login-out-");
	put("TASK.txt", TASK);
	put("notes/creds.txt", "Token: abc\n");
	put("prod.env", "Password: p\n");
	put("notes/x.ENV", "Password: p\n");
	put(".tmp/seed.txt");
	put(".git/config", "[core]");
	put(".env", "SECRET=1");
	put("src/app.ts", "export {};");
	writeFileSync(join(outside, "TASK.txt"), TASK);
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(outside, "TASK.txt"), join(ws, "link.txt"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-login-nocal-"),
	});
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
});

const ok = (c: string) => loginLineToTmp(c, ws).ok;

describe("loginLineToTmp allows", () => {
	test("the pilot's exact command", () => {
		const r = loginLineToTmp(PILOT_CMD, ws);
		expect(r.ok).toBe(true);
		expect((r as { reason: string }).reason).toBe(
			'sed copy of the "Password:" line of TASK.txt into .tmp/login, printing nothing',
		);
	});
	test("the recipe exactly as LOCAL_LOGIN_NOTE prescribes it (the prompt and the lane cannot drift apart)", () => {
		const sed = /\((sed -n '[^']*' FILE),/.exec(LOCAL_LOGIN_NOTE)?.[1];
		expect(sed).toBeDefined();
		expect(ok((sed as string).replace("FILE", "TASK.txt"))).toBe(true);
	});
	test("another label and field, a file in a subdirectory, another plain output name", () => {
		expect(ok("sed -n 's/^Token: */token=/w .tmp/tok.txt' notes/creds.txt")).toBe(true);
		expect(ok("sed -n 's/^API key: */api_key=/w .tmp/key' TASK.txt")).toBe(true);
	});
	test("when .tmp does not exist yet (sed creates the file)", () => {
		rmSync(join(ws, ".tmp"), { recursive: true, force: true });
		expect(ok(PILOT_CMD)).toBe(true);
	});
	test("the command does what the note says: one relabelled line in the file, nothing printed", () => {
		const run = Bun.spawnSync(["sh", "-c", PILOT_CMD], { cwd: ws });
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toBe("");
		expect(run.stderr.toString()).toBe("");
		expect(readFileSync(join(ws, ".tmp/login"), "utf8")).toBe("password=yGfoi4qmTmGEvy\n");
	});
});

describe("loginLineToTmp refuses", () => {
	const refused: Array<[string, string]> = [
		["p flag: prints the value into the transcript", "sed -n 's/^Password: *//p' TASK.txt"],
		["p after w", "sed -n 's/^Password: */password=/wp .tmp/login' TASK.txt"],
		["g flag before w", "sed -n 's/^Password: */password=/gw .tmp/login' TASK.txt"],
		["no -n", "sed 's/^Password: */password=/w .tmp/login' TASK.txt"],
		["-i", "sed -n -i 's/^Password: */password=/w .tmp/login' TASK.txt"],
		["-E", "sed -nE 's/^Password: */password=/w .tmp/login' TASK.txt"],
		["-e", "sed -n -e 's/^Password: */password=/w .tmp/login' TASK.txt"],
		["-f script", "sed -n -f script.sed TASK.txt"],
		// #4303 (run 2026-10-15_064256): the two forms System One blocked stay refused by this lane.
		[
			"two -e with p and a shell redirect (run call 34)",
			"sed -n -e 's/^Username: */username=/p' -e 's/^Password: /password=/p' TASK.txt > .tmp/login",
		],
		[
			"p flag with a shell redirect to a file (run call 40)",
			"sed -n 's/^Password: /password=/p' TASK.txt > .tmp/password.txt",
		],
		["two expressions", "sed -n 's/^Password: */password=/w .tmp/login' -e 'p' TASK.txt"],
		["two files", "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt .env"],
		["no file (stdin)", "sed -n 's/^Password: */password=/w .tmp/login'"],
		["double quotes", 'sed -n "s/^Password: */password=/w .tmp/login" TASK.txt'],
		["unquoted script", "sed -n s/^Password:\\ */password=/w\\ .tmp/login TASK.txt"],
		["output outside .tmp", "sed -n 's/^Password: */password=/w login' TASK.txt"],
		[
			"output in a subdirectory of .tmp",
			"sed -n 's/^Password: */password=/w .tmp/sub/login' TASK.txt",
		],
		["output in /tmp", "sed -n 's/^Password: */password=/w /tmp/login' TASK.txt"],
		["output with ..", "sed -n 's/^Password: */password=/w .tmp/../login' TASK.txt"],
		["output is a script name", "sed -n 's/^Password: */password=/w .tmp/login.sh' TASK.txt"],
		["output is a config name", "sed -n 's/^Password: */password=/w .tmp/package.json' TASK.txt"],
		["output is a secret name", "sed -n 's/^Password: */password=/w .tmp/credentials' TASK.txt"],
		["input is a secret file", "sed -n 's/^SECRET=*/secret=/w .tmp/login' .env"],
		[
			"input is prod.env (a dotenv under another name, 8SO)",
			"sed -n 's/^Password: */password=/w .tmp/login' prod.env",
		],
		[
			"input is x.ENV in a subdirectory",
			"sed -n 's/^Password: */password=/w .tmp/login' notes/x.ENV",
		],
		["input in a dot directory", "sed -n 's/^Password: */password=/w .tmp/login' .git/config"],
		["input under .tmp", "sed -n 's/^Password: */password=/w .tmp/login' .tmp/seed.txt"],
		["input with ..", "sed -n 's/^Password: */password=/w .tmp/login' ../TASK.txt"],
		[
			"input absolute (outside the workspace)",
			"sed -n 's/^Password: */password=/w .tmp/login' OUTSIDE/TASK.txt",
		],
		[
			"input through a symlinked directory",
			"sed -n 's/^Password: */password=/w .tmp/login' escape/TASK.txt",
		],
		["input is a symlink", "sed -n 's/^Password: */password=/w .tmp/login' link.txt"],
		["input missing", "sed -n 's/^Password: */password=/w .tmp/login' missing.txt"],
		["input is a directory", "sed -n 's/^Password: */password=/w .tmp/login' notes"],
		[
			"input is a protected path",
			"sed -n 's/^Password: */password=/w .tmp/login' packages/permissions/gate.ts",
		],
		["input starts with a dash", "sed -n 's/^Password: */password=/w .tmp/login' -TASK.txt"],
		["label with a slash", "sed -n 's/^Pass/word: */password=/w .tmp/login' TASK.txt"],
		["label empty", "sed -n 's/^: */password=/w .tmp/login' TASK.txt"],
		["field uppercase", "sed -n 's/^Password: */Password=/w .tmp/login' TASK.txt"],
		["field empty", "sed -n 's/^Password: */=/w .tmp/login' TASK.txt"],
		["no anchor", "sed -n 's/Password: */password=/w .tmp/login' TASK.txt"],
		["no star", "sed -n 's/^Password: /password=/w .tmp/login' TASK.txt"],
		["semicolon", "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt; cat .tmp/login"],
		["and-chain", "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt && cat .tmp/login"],
		["pipe", "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt | cat"],
		["redirect", "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt > out"],
		["substitution", "sed -n 's/^Password: */password=/w .tmp/login' $(echo TASK.txt)"],
		["env prefix", "LC_ALL=C sed -n 's/^Password: */password=/w .tmp/login' TASK.txt"],
		["gnu e command", "sed -n 's/^Password: */password=/we .tmp/login' TASK.txt"],
		["trailing space inside the quote", "sed -n 's/^Password: */password=/w .tmp/login ' TASK.txt"],
		["newline", "sed -n 's/^Password: */password=/w .tmp/login'\nTASK.txt"],
		[
			"awk variant from the same session",
			"awk -F': ' '/^Password:/ {print \"password=\" $2}' TASK.txt > .tmp/cred.txt",
		],
	];
	for (const [why, cmd] of refused)
		test(why, () => expect(ok(cmd.replace("OUTSIDE", outside)), cmd).toBe(false));

	test("no cwd, or a relative one", () => {
		expect(loginLineToTmp(PILOT_CMD, undefined).ok).toBe(false);
		expect(loginLineToTmp(PILOT_CMD, "work").ok).toBe(false);
	});
	test(".tmp is a symlink", () => {
		rmSync(join(ws, ".tmp"), { recursive: true, force: true });
		symlinkSync(outside, join(ws, ".tmp"));
		expect(ok(PILOT_CMD)).toBe(false);
	});
	test(".tmp is a file", () => {
		rmSync(join(ws, ".tmp"), { recursive: true, force: true });
		writeFileSync(join(ws, ".tmp"), "x");
		expect(ok(PILOT_CMD)).toBe(false);
	});
	test(".tmp/login is a symlink out of the workspace (dangling included)", () => {
		symlinkSync(join(outside, "login"), join(ws, ".tmp/login"));
		expect(ok(PILOT_CMD)).toBe(false);
	});
	test("a workspace that is itself a symlink resolves to the same real root", () => {
		const alias = join(tempDir("s1-login-alias-"), "ws");
		symlinkSync(ws, alias);
		expect(loginLineToTmp(PILOT_CMD, alias).ok).toBe(true);
		expect(
			loginLineToTmp("sed -n 's/^Password: */password=/w .tmp/login' link.txt", alias).ok,
		).toBe(false);
	});
});

describe("systemOneGate with the lane", () => {
	test("runs the pilot's command without asking the judge", async () => {
		const r = await systemOneGate(PILOT_CMD, process.env, ws);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(r.guard?.reason).toContain("printing nothing");
		expect(judge.asks).toBe(0);
	});
	// With an uncalibrated judge, default mode falls to the rules (and allows); what these
	// tests check is that the lane did not speak, so the verdict is not the allowlist's.
	const notTheLane = (r: Awaited<ReturnType<typeof systemOneGate>>) => {
		expect(r.guard?.backend).not.toBe("allowlist");
		expect(r.guard?.reason ?? "").not.toContain("printing nothing");
	};
	test("a deviation is not the lane's: the rules and the judge decide as before (prod.env included)", async () => {
		for (const cmd of [
			"sed -n 's/^Password: *//p' TASK.txt",
			"sed -n 's/^Password: */password=/w .tmp/login' link.txt",
			"sed -n 's/^Password: */password=/w .tmp/login' prod.env",
		]) {
			notTheLane(await systemOneGate(cmd, process.env, ws));
		}
	});
	test("strict mode (Guarded) never uses the lane", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate(PILOT_CMD, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		notTheLane(await systemOneGate(PILOT_CMD, process.env, ws));
	});
	test("without a cwd the lane has no opinion", async () => {
		notTheLane(await systemOneGate(PILOT_CMD, process.env));
	});
	test("the real workspace path is what the lane checks (symlinked cwd)", async () => {
		const alias = join(tempDir("s1-login-alias2-"), "ws");
		symlinkSync(ws, alias);
		const r = await systemOneGate(PILOT_CMD, process.env, alias);
		expect(r.run).toBe(true);
		expect(judge.asks).toBe(0);
		expect(realpathSync(alias)).toBe(realpathSync(ws));
	});
});
