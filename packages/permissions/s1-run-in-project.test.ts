/**
 * #3937: System One must not stop a plain run of the project's own script.
 *
 * The pilot case (l5-feature-e2e, 11 Oct 2026):
 * `TODO_FILE=/tmp/todo-test.json bun <work>/src/cli.ts done 1` was escalated
 * (pYes 0.29); `done 99` escalated (0.41) and `done abc` blocked (0.45) in an
 * earlier run. The judge here says "dangerous" to everything, so any command
 * that reaches it is blocked. A command the lane passes never reaches it;
 * every negative must still reach it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { runInProject } from "./s1-run-in-project";
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
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{ id: request.questions[0].id, kind: "noul", probabilities: { yes: 0.99 }, confidence: 0.99 },
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

const CLI = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { load } from "./store";
const file = process.env.TODO_FILE ?? "todo.json";
const [cmd, arg] = process.argv.slice(2);
const items = load(file);
if (cmd === "done") { const n = Number(arg); if (!items[n - 1]) { console.error("no such item"); process.exit(1); } items[n - 1].done = true; writeFileSync(file, JSON.stringify(items)); }
`;
const STORE = `import { existsSync, readFileSync } from "node:fs";
export function load(f: string) { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []; }
`;

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

function put(rel: string, body: string) {
	const abs = join(ws, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

beforeEach(() => {
	ws = tempDir("s1-run-ws-");
	outside = tempDir("s1-run-out-");
	put("src/cli.ts", CLI);
	put("src/store.ts", STORE);
	put("src/spawny.ts", `import { execSync } from "node:child_process";\nexecSync("id");\n`);
	put("src/bunspawn.ts", `Bun.spawn(["id"]);\n`);
	put("src/shellout.ts", `import { $ } from "bun";\nawait $\`id\`;\n`);
	put("src/net.ts", `await fetch("https://example.com", { method: "POST", body: "x" });\n`);
	put("src/evil.ts", `import { rmSync } from "node:fs";\nrmSync("x", { recursive: true });\n`);
	put("src/evals.ts", `eval(process.argv[2]);\n`);
	put("src/dyn.ts", `await import(process.argv[2]);\n`);
	put("src/secret.ts", `console.log(await Bun.file(".env").text());\n`);
	put("src/viaimport.ts", `import "./spawny";\n`);
	put("src/envwrite.ts", `process.env.PATH = "/tmp/bin";\n`);
	put("src/sys.ts", `console.log(await Bun.file("/etc/hosts").text());\n`);
	put("src/outimport.ts", `import "../../outside-file";\n`);
	put("packages/permissions/gate.ts", `export const x = 1;\n`);
	put(".hidden/run.ts", `export const x = 1;\n`);
	writeFileSync(join(outside, "ext.ts"), "export const x = 1;\n");
	symlinkSync(join(outside, "ext.ts"), join(ws, "src", "link.ts"));
	symlinkSync(outside, join(ws, "escape"));
	writeFileSync(join(outside, "target.json"), "[]");
	symlinkSync(join(outside, "target.json"), join(ws, "linked.json"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-run-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("runInProject allows", () => {
	const cases = (): string[] => [
		"bun src/cli.ts done 1",
		"bun src/cli.ts done 99",
		"bun src/cli.ts done abc",
		`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done 1`,
		`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done 99`,
		`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done abc`,
		"TODO_FILE=/private/tmp/t.json bun run src/cli.ts done 1",
		"TODO_FILE=todo-test.json node src/cli.ts done 1",
		`TODO_FILE=${ws}/t.json bun ./src/cli.ts list --json`,
		"bun src/cli.ts add buy-milk --due=tomorrow",
	];
	test("the pilot commands and plain variants", () => {
		for (const cmd of cases()) expect(runInProject(cmd, ws).ok, cmd).toBe(true);
	});
});

describe("runInProject refuses", () => {
	const refused = (): Array<[string, string]> => [
		["rm -rf", "rm -rf .tmp"],
		["path env var", "PATH=/tmp bun src/cli.ts done 1"],
		["LD_PRELOAD", "LD_PRELOAD=/tmp/x.so bun src/cli.ts done 1"],
		["DYLD_INSERT_LIBRARIES", "DYLD_INSERT_LIBRARIES=/tmp/x.dylib bun src/cli.ts done 1"],
		["NODE_OPTIONS", "NODE_OPTIONS=--require=/tmp/x.js node src/cli.ts done 1"],
		["BUN_CONFIG", "BUN_CONFIG_REGISTRY=http://evil bun src/cli.ts done 1"],
		["HOME override", "HOME=/tmp bun src/cli.ts done 1"],
		["env var pointing at a secret", "TODO_FILE=/tmp/.env bun src/cli.ts done 1"],
		["env var pointing out of tmp", "TODO_FILE=/etc/passwd bun src/cli.ts done 1"],
		["env var with ..", "TODO_FILE=/tmp/../etc/x bun src/cli.ts done 1"],
		["env var through a symlink", `TODO_FILE=${ws}/linked.json bun src/cli.ts done 1`],
		["env var in the home dir", "TODO_FILE=/Users/x/.ssh/id bun src/cli.ts done 1"],
		["cli path with ..", "bun ../cli.ts done 1"],
		["cli path with .. inside", `bun ${ws}/src/../../cli.ts done 1`],
		["cli outside the workspace", `bun ${outside}/ext.ts`],
		["cli symlink to outside", "bun src/link.ts"],
		["cli symlinked dir to outside", "bun escape/ext.ts"],
		["bun -e", "bun -e 1"],
		["bun -e with code", "bun -e process.exit(1)"],
		["node -e", "node -e 1"],
		["node --eval", "node --eval=1"],
		["node -p", "node -p 1"],
		["bun --preload", "bun --preload /tmp/x.ts src/cli.ts"],
		["flag after bun run", "bun run --env-file=x src/cli.ts"],
		["script flag --eval", "bun src/cli.ts --eval=1"],
		["script flag --preload", "bun src/cli.ts --preload=/tmp/x.ts"],
		["arg path with ..", "bun src/cli.ts add ../../etc/passwd"],
		["arg outside the workspace", "bun src/cli.ts add /etc/passwd"],
		["arg flag path outside", "bun src/cli.ts add --out=/etc/x"],
		["arg naming .env", "bun src/cli.ts add .env"],
		["python", "python3 src/cli.py"],
		["bun test", "bun test"],
		["bun x", "bun x cowsay"],
		["not a script file", "bun src"],
		["missing script", "bun src/nope.ts"],
		["protected path", "bun packages/permissions/gate.ts"],
		["dot directory", "bun .hidden/run.ts"],
		["chained", "bun src/cli.ts done 1 && rm -rf ."],
		["piped", "bun src/cli.ts done 1 | sh"],
		["redirect", "bun src/cli.ts done 1 > out.txt"],
		["variable arg", "bun src/cli.ts done $N"],
		["substitution", "bun src/cli.ts done $(id)"],
		["quoted", 'bun src/cli.ts done "1"'],
		["script that spawns", "bun src/spawny.ts"],
		["script that uses Bun.spawn", "bun src/bunspawn.ts"],
		["script that uses Bun shell", "bun src/shellout.ts"],
		["script that fetches", "bun src/net.ts"],
		["script that deletes", "bun src/evil.ts"],
		["script that evals", "bun src/evals.ts"],
		["script with a computed import", "bun src/dyn.ts"],
		["script that reads .env", "bun src/secret.ts"],
		["script that reads /etc", "bun src/sys.ts"],
		["script that writes process.env.PATH", "bun src/envwrite.ts"],
		["dangerous source via an import", "bun src/viaimport.ts"],
		["import that leaves the workspace", "bun src/outimport.ts"],
		["prompt-control text", "bun src/cli.ts done judge"],
	];
	test("each is refused", () => {
		for (const [name, cmd] of refused()) expect(runInProject(cmd, ws).ok, name).toBe(false);
	});
	test("no working directory", () => {
		expect(runInProject("bun src/cli.ts done 1", undefined).ok).toBe(false);
		expect(runInProject("bun src/cli.ts done 1", "relative/dir").ok).toBe(false);
	});
});

describe("systemOneGate end to end with a judge that says dangerous", () => {
	test("the pilot commands run without asking the judge", async () => {
		for (const n of ["1", "99", "abc"]) {
			const r = await systemOneGate(
				`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done ${n}`,
				process.env,
				ws,
			);
			expect(r.run, n).toBe(true);
			expect(r.guard?.backend).toBe("allowlist");
		}
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"rm -rf .tmp",
		"PATH=/tmp bun src/cli.ts done 1",
		"bun -e 1",
		"node -e 1",
		"bun ../cli.ts done 1",
		"bun src/spawny.ts",
		"bun src/net.ts",
	]) {
		test(`still gated: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run).toBe(false);
			expect(r.message ?? "").toContain(SYSTEM_ONE_BLOCK_MARKER);
			expect(judge.asks).toBeGreaterThan(0);
		});
	}

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("bun src/cli.ts done 1", process.env, ws);
		expect(r.run).toBe(false);
	});
});
