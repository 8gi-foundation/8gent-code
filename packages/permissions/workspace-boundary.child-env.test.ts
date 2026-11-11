/**
 * The boundary check judges a `$VAR` path by the value the run_command shell will see, not the
 * value in the 8gent process. The shell gets a minimal environment (child-env.ts), so a name
 * the 8gent process has and the shell does not expands to nothing there, and the check must
 * judge that same, empty expansion. Production call shapes: the read boundary through
 * systemOneGate, the write boundary through evaluatePolicy("run_command").
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildChildEnv, runCommandEnv } from "../eight/harness/child-env";
import { ToolExecutor } from "../eight/tools";
import { evaluatePolicy } from "./policy-engine";
import { resetReadAllow } from "./read-allow";
import { boundaryEnv } from "./src/workspace-boundary";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
/** An existing file outside the workspace. */
let outFile: string;
/** An existing folder outside the workspace. */
let outDir: string;

/** Names this file sets in process.env; each is put back as it was. */
const TOUCHED = [
	"OLDPWD",
	"ZZ_BCE_WITHHELD",
	"ZZ_BCE_WORD",
	"ZZ_BCE_UNSET",
	"ZZ_BCE_PASSED",
	"EIGHT_SHELL_ENV_PASS",
	"XDG_CACHE_HOME",
	"EIGHT_HEADLESS_APPROVE",
];
const saved = new Map(TOUCHED.map((k) => [k, process.env[k]]));
const restore = () => {
	for (const [k, v] of saved) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
};

beforeAll(() => {
	fs.mkdirSync(repoTmp, { recursive: true });
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "bce-")));
	ws = path.join(base, "proj");
	outDir = path.join(base, "outside");
	outFile = path.join(base, "x");
	fs.mkdirSync(ws, { recursive: true });
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(outFile, "OUTSIDE");
	fs.writeFileSync(path.join(ws, "inside.txt"), "inside");
	fs.mkdirSync(path.join(ws, "src"), { recursive: true });
});

afterAll(() => {
	restore();
	_resetSystemOne();
	resetReadAllow();
	fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
	_setSystemOneOverridesForTests({ askHuman: async () => null }); // nobody can answer
});
afterEach(restore);

/** The read boundary as run_command meets it: System One off, so the boundary alone decides. */
const read = async (command: string) => {
	const env = { ...process.env, [SYSTEM_ONE_FLAG]: "0" };
	const r = await systemOneGate(command, env, ws, undefined, undefined, { project: ws });
	return r.run ? "ran" : "refused";
};
/** The write boundary as run_command meets it: the policy engine's pre-check. */
const write = (command: string) =>
	evaluatePolicy("run_command", { command, workspaceRoot: ws }).allowed ? "allowed" : "refused";

/** A name the 8gent process has and the shell will not: not in the allowlist, not passed. */
const withhold = (name: string, value: string) => {
	process.env[name] = value;
	expect(name in runCommandEnv(process.env)).toBe(false);
};

describe("a literal outside path is refused", () => {
	test("read", async () => expect(await read(`cat ${outFile}`)).toBe("refused"));
	test("write", () => expect(write(`touch ${outDir}/f`)).toBe("refused"));
});

describe("a variable the 8gent process has and the shell does not expands to nothing", () => {
	test("read through a withheld variable that points inside", async () => {
		withhold("ZZ_BCE_WITHHELD", ws);
		expect(await read(`cat $ZZ_BCE_WITHHELD${outFile}`)).toBe("refused");
	});
	test("read through OLDPWD pointing inside (the shell never receives it)", async () => {
		withhold("OLDPWD", ws);
		expect(await read(`cat $OLDPWD${outFile}`)).toBe("refused");
	});
	test("read through a withheld variable holding a plain word", async () => {
		withhold("ZZ_BCE_WORD", "word");
		expect(await read(`cat $ZZ_BCE_WORD${outFile}`)).toBe("refused");
	});
	test("write through a withheld variable that points inside", () => {
		withhold("ZZ_BCE_WITHHELD", ws);
		expect(write(`touch $ZZ_BCE_WITHHELD${outDir}/f`)).toBe("refused");
	});
	test("write through OLDPWD pointing inside", () => {
		withhold("OLDPWD", ws);
		expect(write(`touch $OLDPWD${outDir}/f`)).toBe("refused");
	});
	test("write through a withheld variable holding a plain word", () => {
		withhold("ZZ_BCE_WORD", "word");
		expect(write(`touch $ZZ_BCE_WORD${outDir}/f`)).toBe("refused");
	});
	test("braced: ${VAR}", async () => {
		withhold("ZZ_BCE_WITHHELD", ws);
		expect(await read(`cat \${ZZ_BCE_WITHHELD}${outFile}`)).toBe("refused");
		expect(write(`touch \${ZZ_BCE_WITHHELD}${outDir}/f`)).toBe("refused");
	});
});

describe("a variable the shell does get is judged on its real value", () => {
	test("an allowlisted name pointing outside is refused, pointing inside runs", async () => {
		process.env.XDG_CACHE_HOME = base;
		expect(await read("cat $XDG_CACHE_HOME/x")).toBe("refused");
		expect(write("touch $XDG_CACHE_HOME/outside/f")).toBe("refused");
		process.env.XDG_CACHE_HOME = ws;
		expect(await read("cat $XDG_CACHE_HOME/inside.txt")).toBe("ran");
		expect(write("touch $XDG_CACHE_HOME/f")).toBe("allowed");
	});
	test("a name passed through EIGHT_SHELL_ENV_PASS is judged on its value", async () => {
		process.env.EIGHT_SHELL_ENV_PASS = "ZZ_BCE_PASSED";
		process.env.ZZ_BCE_PASSED = base;
		expect(await read("cat $ZZ_BCE_PASSED/x")).toBe("refused");
		expect(write("touch $ZZ_BCE_PASSED/outside/f")).toBe("refused");
		process.env.ZZ_BCE_PASSED = ws;
		expect(await read("cat $ZZ_BCE_PASSED/inside.txt")).toBe("ran");
		expect(write("touch $ZZ_BCE_PASSED/f")).toBe("allowed");
	});
	test("a value with path traversal is judged where it lands", async () => {
		process.env.XDG_CACHE_HOME = `${ws}/..`;
		expect(await read("cat $XDG_CACHE_HOME/x")).toBe("refused");
		expect(write("touch $XDG_CACHE_HOME/outside/f")).toBe("refused");
		process.env.XDG_CACHE_HOME = `${ws}/../proj`;
		expect(await read("cat $XDG_CACHE_HOME/inside.txt")).toBe("ran");
	});
});

describe("an unset variable expands to nothing", () => {
	test("read and write", async () => {
		Reflect.deleteProperty(process.env, "ZZ_BCE_UNSET");
		expect(await read(`cat $ZZ_BCE_UNSET${outFile}`)).toBe("refused");
		expect(write(`touch $ZZ_BCE_UNSET${outDir}/f`)).toBe("refused");
	});
});

describe("forms the check cannot resolve are never judged inside", () => {
	test("${VAR:-x} with a withheld name", () => {
		withhold("ZZ_BCE_WITHHELD", ws);
		expect(write(`touch \${ZZ_BCE_WITHHELD:-}${outDir}/f`)).toBe("refused");
		expect(write(`touch \${ZZ_BCE_WITHHELD:-${ws}}/../outside/f`)).toBe("refused");
	});
	test("command substitution", () => {
		expect(write(`touch $(echo ${ws})/../outside/f`)).toBe("refused");
		expect(write(`touch "$(printf '%s' ${outDir})/f"`)).toBe("refused");
		expect(write("touch `echo ..`/outside/f")).toBe("refused");
	});
});

describe("the shell keeps PWD and OLDPWD itself", () => {
	test("after a cd on the line, $OLDPWD is the folder the line left", async () => {
		withhold("OLDPWD", path.join(ws, "src"));
		expect(await read("cd src && cat $OLDPWD/../x")).toBe("refused");
		expect(write("cd src && touch $OLDPWD/../outside/f")).toBe("refused");
		expect(write("cd src && touch $OLDPWD/f")).toBe("allowed");
	});
	test("$PWD is the folder the shell is in, not the 8gent process's", () => {
		expect(write("cd src && touch $PWD/../../outside/f")).toBe("refused");
		expect(write("cd src && touch $PWD/f")).toBe("allowed");
	});
});

/** NAME=value lines a shell's `env` printed, first line of each value only. */
const parseEnv = (out: string) =>
	new Map([...out.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]));
/** Names a POSIX shell sets for itself whatever it was handed. */
const SHELL_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

describe("the check and the shell build their environment in one place", () => {
	test("the boundary's environment is runCommandEnv's, not the process's", () => {
		process.env.EIGHT_SHELL_ENV_PASS = "ZZ_BCE_PASSED";
		process.env.ZZ_BCE_PASSED = ws;
		process.env.ZZ_BCE_WITHHELD = ws;
		expect(boundaryEnv()).toEqual(runCommandEnv(process.env));
		for (const k of Object.keys(buildChildEnv(process.env)))
			expect(boundaryEnv()[k]).toBe(process.env[k]);
		expect(boundaryEnv().ZZ_BCE_PASSED).toBe(ws);
		expect("ZZ_BCE_WITHHELD" in boundaryEnv()).toBe(false);
	});

	test("the real run_command shell sees exactly the names and values the boundary judged", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		process.env.EIGHT_SHELL_ENV_PASS = "ZZ_BCE_PASSED";
		process.env.ZZ_BCE_PASSED = ws;
		process.env.ZZ_BCE_WITHHELD = ws;
		const out = String(await new ToolExecutor(ws).execute("run_command", { command: "env" }));
		const shell = parseEnv(out);
		const judged = boundaryEnv();
		const names = (keys: Iterable<string>) => [...keys].filter((k) => !SHELL_OWN.has(k)).sort();
		expect(names(shell.keys())).toEqual(names(Object.keys(judged)));
		for (const k of names(shell.keys())) expect([k, shell.get(k)]).toEqual([k, judged[k]?.split("\n")[0]]);
	});

	test("through the real run_command, a withheld variable does not carry a read outside", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		withhold("ZZ_BCE_WITHHELD", ws);
		const out = String(
			await new ToolExecutor(ws).execute("run_command", { command: `cat $ZZ_BCE_WITHHELD${outFile}` }),
		);
		expect(out).not.toContain("OUTSIDE");
		expect(out).toContain("[BLOCKED]");
	});
});
