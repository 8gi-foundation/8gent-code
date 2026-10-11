/**
 * #3937: System One must not stop a plain run of the project's own script,
 * and (8SO review, 28 of 28 bypasses of the first version) must not pass
 * anything a script can use to spawn, fetch, delete, write outside its lane,
 * or load code it did not show.
 *
 * The judge here says "dangerous" to everything, so any command that reaches
 * it is blocked. A command the lane passes never reaches it; every negative
 * must still reach it (runInProject false, and the gate not "allowlist").
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { runInProject, tokenize } from "./s1-run-in-project";
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
			answers: [{ id: request.questions[0].id, kind: "noul", probabilities: { yes: 0.99 }, confidence: 0.99 }],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

// The pilot's real todo CLI (l5-feature-e2e, 11 Oct 2026), unchanged.
const PILOT_CLI = `#!/usr/bin/env bun
import { add, load, markDone, save } from "./store";

const [cmd, ...rest] = process.argv.slice(2);
const todos = load();

switch (cmd) {
	case "add": {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error("usage: todo add <text>");
			process.exit(1);
		}
		const t = add(todos, text);
		save(todos);
		console.log(\`added \${t.id}\`);
		break;
	}
	case "list":
		for (const t of todos) console.log(\`\${t.done ? "[x]" : "[ ]"} \${t.id}   \${t.text}\`);
		break;
	case "done": {
		const id = Number(rest[0]);
		if (rest[0] === undefined || Number.isNaN(id)) {
			console.error("usage: todo done <id>");
			process.exit(1);
		}
		if (!markDone(todos, id)) {
			console.error(\`no todo with id \${id}\`);
			process.exit(1);
		}
		save(todos);
		console.log(\`done \${id}\`);
		break;
	}
	default:
		console.error("usage: todo <add|list|done> ...");
		process.exit(1);
}
`;
const PILOT_STORE = `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Todo = { id: number; text: string; done?: boolean };

export const todoFile = () => process.env.TODO_FILE ?? "todos.json";

export function load(): Todo[] {
	const f = todoFile();
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Todo[]) : [];
}

export function save(todos: Todo[]): void {
	writeFileSync(todoFile(), \`\${JSON.stringify(todos, null, 2)}\\n\`);
}

export function add(todos: Todo[], text: string): Todo {
	const todo = { id: todos.reduce((m, t) => Math.max(m, t.id), 0) + 1, text, done: false };
	todos.push(todo);
	return todo;
}

export function markDone(todos: Todo[], id: number): boolean {
	const todo = todos.find((t) => t.id === id);
	if (todo) todo.done = true;
	return todo !== undefined;
}
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

function put(rel: string, body: string, root = ws) {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

/** A fresh workspace holding the given files (the pilot CLI is not included). */
let n = 0;
function mk(files: Record<string, string>): string {
	const d = tempDir(`s1-run-${n++}-`);
	for (const [k, v] of Object.entries(files)) put(k, v, d);
	return d;
}

beforeEach(() => {
	ws = tempDir("s1-run-ws-");
	outside = tempDir("s1-run-out-");
	put("src/cli.ts", PILOT_CLI);
	put("src/store.ts", PILOT_STORE);
	put("packages/permissions/gate.ts", "export const x = 1;\n");
	put(".hidden/run.ts", "export const x = 1;\n");
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
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
});

describe("runInProject allows the pilot's real CLI", () => {
	test("done 1 / 99 / abc with the pilot's env prefix", () => {
		for (const arg of ["1", "99", "abc"])
			expect(runInProject(`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done ${arg}`, ws).ok, arg).toBe(true);
	});
	test("other shapes of the same CLI", () => {
		for (const cmd of [
			"TODO_FILE=/private/tmp/t.json bun src/cli.ts done 1",
			"TODO_FILE=todo-test.json node src/cli.ts done 1",
			`TODO_FILE=${ws}/t.json bun ./src/cli.ts list`,
			"TODO_FILE=/tmp/t.json bun src/cli.ts add buy-milk",
		])
			expect(runInProject(cmd, ws).ok, cmd).toBe(true);
	});
});

describe("runInProject refuses", () => {
	const base = "TODO_FILE=/tmp/todo-test.json";
	test("command shapes", () => {
		const bad: Array<[string, string]> = [
			["rm -rf", "rm -rf .tmp"],
			["bun run (runs a package.json script of that name)", `${base} bun run src/cli.ts done 1`],
			["no env supplied, script reads TODO_FILE", "bun src/cli.ts done 1"],
			["PATH", `PATH=/tmp ${base} bun src/cli.ts done 1`],
			["LD_PRELOAD", `LD_PRELOAD=/tmp/x.so ${base} bun src/cli.ts done 1`],
			["DYLD", `DYLD_INSERT_LIBRARIES=/tmp/x ${base} bun src/cli.ts done 1`],
			["NODE_OPTIONS", `NODE_OPTIONS=--require=/tmp/x.js ${base} node src/cli.ts done 1`],
			["BUN_ var", `BUN_CONFIG_REGISTRY=http://evil ${base} bun src/cli.ts done 1`],
			["OPENSSL_CONF", `OPENSSL_CONF=${ws}/o.cnf ${base} node src/cli.ts done 1`],
			["SSL_CERT_FILE", `SSL_CERT_FILE=/tmp/x ${base} node src/cli.ts done 1`],
			["HOME", `HOME=/tmp ${base} bun src/cli.ts done 1`],
			["env the script never reads", `FOO=bar ${base} bun src/cli.ts done 1`],
			["env at a secret", "TODO_FILE=/tmp/.env bun src/cli.ts done 1"],
			["env out of tmp", "TODO_FILE=/etc/passwd bun src/cli.ts done 1"],
			["env with ..", "TODO_FILE=/tmp/../etc/x bun src/cli.ts done 1"],
			["env through a symlink", `TODO_FILE=${ws}/linked.json bun src/cli.ts done 1`],
			["env at source (write target)", `TODO_FILE=${ws}/src/cli.ts bun src/cli.ts done 1`],
			["env at package.json (write target)", `TODO_FILE=${ws}/package.json bun src/cli.ts done 1`],
			["env at a dot name (write target)", "TODO_FILE=.bashrc bun src/cli.ts done 1"],
			["cli with ..", `${base} bun ../cli.ts done 1`],
			["cli with .. inside", `${base} bun ${ws}/src/../../cli.ts done 1`],
			["cli outside", `${base} bun ${outside}/ext.ts`],
			["cli symlink", `${base} bun src/link.ts`],
			["cli through symlinked dir", `${base} bun escape/ext.ts`],
			["bun -e", "bun -e 1"],
			["bun -e code", "bun -e process.exit(1)"],
			["node -e", "node -e 1"],
			["node --eval", "node --eval=1"],
			["node -p", "node -p 1"],
			["bun --preload", `${base} bun --preload /tmp/x.ts src/cli.ts`],
			["bun --env-file", `${base} bun --env-file=x src/cli.ts`],
			["script flag --eval", `${base} bun src/cli.ts --eval=1`],
			["script flag --preload", `${base} bun src/cli.ts --preload=/tmp/x.ts`],
			["arg with ..", `${base} bun src/cli.ts add ../../etc/passwd`],
			["arg absolute outside", `${base} bun src/cli.ts add /etc/passwd`],
			["arg --out outside", `${base} bun src/cli.ts add --out=/etc/x`],
			["arg .env", `${base} bun src/cli.ts add .env`],
			["arg ending in a dot", `${base} bun src/cli.ts add x.`],
			["python", `${base} python3 src/cli.py`],
			["bun test", "bun test"],
			["bun x", "bun x cowsay"],
			["not a script", `${base} bun src`],
			["missing", `${base} bun src/nope.ts`],
			["protected path", `${base} bun packages/permissions/gate.ts`],
			["dot dir", `${base} bun .hidden/run.ts`],
			["chained", `${base} bun src/cli.ts done 1 && rm -rf .`],
			["piped", `${base} bun src/cli.ts done 1 | sh`],
			["redirect", `${base} bun src/cli.ts done 1 > out.txt`],
			["variable", `${base} bun src/cli.ts done $N`],
			["substitution", `${base} bun src/cli.ts done $(id)`],
			["quoted", `${base} bun src/cli.ts done "1"`],
			["prompt-control", `${base} bun src/cli.ts done judge`],
		];
		for (const [name, cmd] of bad) expect(runInProject(cmd, ws).ok, name).toBe(false);
	});
	test("no working directory", () => {
		expect(runInProject("bun src/cli.ts", undefined).ok).toBe(false);
		expect(runInProject("bun src/cli.ts", "relative/dir").ok).toBe(false);
	});
});

// 8SO's 28 bypasses (probe /tmp/claude-501/k/zz-karen-probe.test.ts, 4 live ones included) plus more. Each is a
// workspace whose cli.ts, `bun src/cli.ts`, must NOT pass the lane.
describe("8SO bypasses all reach the judge", () => {
	const scripts: Record<string, string> = {
		"Bun.$ template": "await Bun.$`echo pwned`;",
		"unicode escape fetch": 'await \\u0066etch("https://example.invalid/x");',
		"unicode escape Bun.spawn": 'Bun.\\u0073pawn(["true"]);',
		"hex escape": 'const a = "\\x66";',
		"aliased fetch (0,fetch)": 'await (0, fetch)("https://example.invalid");',
		"fetch in a variable": 'const f = fetch; await f("https://example.invalid");',
		"Bun[computed]": 'const B = Bun as any; B["sp" + "awn"](["true"]);',
		"globalThis computed": '(globalThis as any)["fe" + "tch"]("https://example.invalid");',
		"constructor chain eval": '[].constructor.constructor("return 1")();',
		"constructor via computed key": 'const k = "con" + "structor"; [][k][k]("return 1")();',
		getBuiltinModule:
			'const cp: any = (process as any).getBuiltinModule("child_" + "process"); cp["exec" + "Sync"]("true");',
		createRequire:
			'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("child_" + "process");',
		"renamed rm import":
			'import { rm as nuke } from "node:fs/promises"; await nuke("../../victim", { recursive: true, force: true });',
		"rm renamed from node:fs": 'import { rmSync as nuke } from "node:fs"; nuke("../../victim");',
		"destructured rm via dynamic import":
			'const { rm: r } = await import("node:fs/promises"); await r("../x", { force: true });',
		"Bun.file().delete()": 'await Bun.file("../../victim").delete();',
		"appendFile ~/.zshrc via ..":
			'import { appendFileSync } from "node:fs"; appendFileSync("../../../../.zshrc", "x");',
		"appendFile via env HOME":
			'import { appendFileSync } from "node:fs"; appendFileSync(process.env.HOME + "/.zshrc", "x");',
		"writeFileSync computed path":
			'import { writeFileSync } from "node:fs"; writeFileSync(process.env.HOME + "/.zshrc", "x");',
		"writeFileSync to a literal not on the command line":
			'import { writeFileSync } from "node:fs"; writeFileSync("/Users/x/.zshrc", "x");',
		"writeFileSync to argv": 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "x");',
		"writeFileSync to source": 'import { writeFileSync } from "node:fs"; writeFileSync("src/cli.ts", "x");',
		"writeFileSync aliased": 'import { writeFileSync } from "node:fs"; const w = writeFileSync; w("a.txt", "x");',
		"Bun.write outside": 'await Bun.write(process.env.HOME + "/.zshrc", "x");',
		"secret path by concat":
			'import { readFileSync } from "node:fs"; readFileSync(process.env.HOME + "/." + "ssh/id_" + "ed25519");',
		"readFileSync of a built path":
			'import { readFileSync } from "node:fs"; const p = "/et" + "c/passwd"; console.log(readFileSync(p));',
		"env secret read": "const k = process.env.OPENROUTER_API_KEY; console.log(k);",
		"process spread": "console.log({ ...process.env });",
		'process["binding"]': '(process as any)["bind" + "ing"]("spawn_sync");',
		"new Worker file not followed": 'new Worker(new URL("./w.ts", import.meta.url));',
		WebAssembly: "await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));",
		"tagged template": "const t = (s: any) => s; t`a`;",
		"regex literal": "const r = /a/g;",
		division: "const d = 4 / 2;",
		this: "console.log(this);",
		"import.meta.require": 'import.meta.require("child_process");',
		"with attributes (macro)": 'import { x } from "./m" with { type: "macro" };',
		"dynamic import": 'await import("./m");',
		require: 'require("child_process");',
		eval: 'eval("1");',
		"new Function": 'new Function("return 1")();',
		Reflect: 'Reflect.get(globalThis, "fetch");',
		Symbol: "console.log(Symbol.iterator);",
		Object: "console.log(Object.keys({}));",
		"computed key destructure": 'const k = "x"; const { [k]: v } = { x: 1 };',
		"computed index": "const a = [1]; const i = 0; console.log(a[i]);",
		"non-ASCII": 'console.log("caf\u00e9");',
		"line separator in comment": "// a\u2028 Bun.spawn(['id']);",
		"html comment": "<!-- x\nBun.spawn(['id']);",
		"bare import": 'import { x } from "somepkg";',
		"node:child_process": 'import { execSync } from "node:child_process"; execSync("id");',
		"node:fs namespace": 'import * as fs from "node:fs"; fs.rmSync("x");',
		"node:fs default": 'import fs from "node:fs"; fs.rmSync("x");',
		"node:fs aliased read": 'import { readFileSync as r } from "node:fs"; r("a");',
		"node:http": 'import http from "node:http";',
		"bun import": 'import { $ } from "bun";',
	};
	test("each one", () => {
		for (const [name, src] of Object.entries(scripts)) {
			const d = mk({ "src/cli.ts": src, "src/w.ts": 'Bun.spawn(["true"]);' });
			expect(runInProject("bun src/cli.ts", d).ok, name).toBe(false);
		}
	});
	test("package import into a writable node_modules", () => {
		const d = mk({
			"src/cli.ts": 'import "evilpkg";',
			"node_modules/evilpkg/index.js": 'require("child_process").execSync("true");',
			"node_modules/evilpkg/package.json": '{"name":"evilpkg","main":"index.js"}',
		});
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("tsconfig paths alias", () => {
		const d = mk({
			"src/cli.ts": 'import "@x/evil";',
			"tsconfig.json": '{"compilerOptions":{"paths":{"@x/*":["./lib/*"]}}}',
			"lib/evil.ts": 'Bun.spawn(["true"]);',
		});
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("bunfig.toml preload in the workspace", () => {
		const d = mk({ "src/cli.ts": "console.log(1);", "bunfig.toml": 'preload = ["./p.ts"]\n', "p.ts": 'Bun.spawn(["true"]);' });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("bunfig.toml beside the script", () => {
		const d = mk({ "src/cli.ts": "console.log(1);", "src/bunfig.toml": "x = 1\n" });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test(".env autoload", () => {
		const d = mk({ "src/cli.ts": "console.log(1);", ".env": "X=1" });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
		const e = mk({ "src/cli.ts": "console.log(1);", ".env.local": "X=1" });
		expect(runInProject("bun src/cli.ts", e).ok).toBe(false);
	});
	test("package.json script named like the file (bun run)", () => {
		const d = mk({ "src/cli.ts": "console.log(1);", "package.json": '{"scripts":{"src/cli.ts":"echo shell"}}' });
		expect(runInProject("bun run src/cli.ts", d).ok).toBe(false);
	});
	test(".node native addon through a local import", () => {
		const d = mk({ "src/cli.ts": 'import "./a";', "src/a.node": "\u0000binary" });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("OPENSSL_CONF to a workspace file (node)", () => {
		const d = mk({ "src/cli.js": "console.log(1);", "o.cnf": "x" });
		expect(runInProject(`OPENSSL_CONF=${d}/o.cnf node src/cli.js`, d).ok).toBe(false);
	});
	test("an import that is ambiguous between a script and an addon", () => {
		const d = mk({ "src/cli.ts": 'import "./a";', "src/a.ts": "export const x = 1;", "src/a.wasm": "x" });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("a clean script that imports a dirty local file", () => {
		const d = mk({
			"src/cli.ts": 'import { x } from "./a";\nconsole.log(x);',
			"src/a.ts": 'Bun.spawn(["id"]);\nexport const x = 1;',
		});
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("an import that leaves the workspace", () => {
		const d = mk({ "src/cli.ts": 'import "../../outside-file";' });
		expect(runInProject("bun src/cli.ts", d).ok).toBe(false);
	});
	test("a clean script is allowed (the lane is not dead)", () => {
		const d = mk({ "src/cli.ts": "const [a, b] = process.argv.slice(2);\nconsole.log(a, b, [1, 2][0]);" });
		expect(runInProject("bun src/cli.ts x y", d).ok).toBe(true);
	});
});

describe("tokenize", () => {
	test("reads the pilot files", () => {
		expect(tokenize(PILOT_CLI)).not.toBeNull();
		expect(tokenize(PILOT_STORE)).not.toBeNull();
	});
	test("refuses what it cannot read", () => {
		for (const s of ["a / b", "/x/", "\\u0041", "x\u00e9", "@dec", "#priv", "'open"]) expect(tokenize(s), s).toBeNull();
	});
});

describe("systemOneGate end to end (default mode) with a judge that says dangerous", () => {
	test("the pilot commands run without asking the judge", async () => {
		for (const arg of ["1", "99", "abc"]) {
			const r = await systemOneGate(`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done ${arg}`, process.env, ws);
			expect(r.run, arg).toBe(true);
			expect(r.guard?.backend).toBe("allowlist");
		}
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"rm -rf .tmp",
		"PATH=/tmp TODO_FILE=/tmp/t.json bun src/cli.ts done 1",
		"bun -e 1",
		"node -e 1",
		"TODO_FILE=/tmp/t.json bun ../cli.ts done 1",
		"TODO_FILE=/tmp/t.json bun run src/cli.ts done 1",
	]) {
		test(`never the allowlist lane: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.guard?.backend).not.toBe("allowlist");
		});
	}

	test("strict mode (Guarded) never skips the judge", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate(`TODO_FILE=/tmp/todo-test.json bun ${ws}/src/cli.ts done 1`, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("TODO_FILE=/tmp/t.json bun src/cli.ts done 1", process.env, ws);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});
