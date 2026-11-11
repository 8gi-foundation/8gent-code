/**
 * The boundary check judges a `$VAR` path by the value the shell that runs the command will see,
 * not the value in the 8gent process. Every judged spawner starts its shell with judgedShellEnv
 * (child-env.ts), and the check expands from the same function. Production call shapes: the
 * read boundary through systemOneGate, the write boundary through evaluatePolicy("run_command"),
 * and each spawner (the tool executor's run_command, the native run_command and background_start)
 * through its real tool.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildChildEnv,
	judgedShellEnv,
	runCommandEnv,
	withShellEnv,
} from "../eight/harness/child-env";
import { ToolExecutor } from "../eight/tools";
import { toolShellEnv } from "./nested-guard";
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
	"ZZ_BCE_DEEP",
	"EIGHT_DECIDE_OLLAMA_HOST",
	"OLLAMA_HOST",
	"EIGHT_WORKSPACE_ROOT",
	"ZZ_BCE_OUT",
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
	fs.writeFileSync(path.join(outDir, "x"), "OUTSIDE-DEEP");
	fs.mkdirSync(path.join(outDir, "deep"));
});

afterAll(() => {
	restore();
	_resetSystemOne();
	resetReadAllow();
	fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
	_setSystemOneOverridesForTests({ askHuman: async () => null }); // nobody can answer
	// No judge model is reachable, so no verdict depends on one.
	process.env.EIGHT_DECIDE_OLLAMA_HOST = "http://127.0.0.1:9";
	process.env.OLLAMA_HOST = "http://127.0.0.1:9";
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

describe("on the write path, forms the check cannot resolve are never judged inside", () => {
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

/** The names and values a shell printed, against the ones the check judged with. */
const sameEnv = (out: string, judged: Record<string, string | undefined>) => {
	const shell = parseEnv(out);
	const names = (keys: Iterable<string>) => [...keys].filter((k) => !SHELL_OWN.has(k)).sort();
	expect(names(shell.keys())).toEqual(names(Object.keys(judged)));
	for (const k of names(shell.keys()))
		expect([k, shell.get(k)]).toEqual([k, judged[k]?.split("\n")[0]]);
};

/** The native tools (the ones capable providers call), bound to the test workspace. */
const native = async (name: string, input: Record<string, unknown>): Promise<string> => {
	const ai = await import("../ai/tools");
	ai.setToolContext({ workingDirectory: ws });
	const tools = ai.agentTools as unknown as Record<
		string,
		{ execute: (i: unknown, o: unknown) => Promise<unknown> }
	>;
	return String(await tools[name].execute(input, { toolCallId: "bce", messages: [] }));
};

describe("the check and the shell build their environment in one place", () => {
	test("the boundary's environment is judgedShellEnv's: runCommandEnv's unless a spawner binds one", () => {
		process.env.EIGHT_SHELL_ENV_PASS = "ZZ_BCE_PASSED";
		process.env.ZZ_BCE_PASSED = ws;
		process.env.ZZ_BCE_WITHHELD = ws;
		expect(boundaryEnv()).toEqual(runCommandEnv(process.env));
		for (const k of Object.keys(buildChildEnv(process.env)))
			expect(boundaryEnv()[k]).toBe(process.env[k]);
		expect(boundaryEnv().ZZ_BCE_PASSED).toBe(ws);
		expect("ZZ_BCE_WITHHELD" in boundaryEnv()).toBe(false);
		const bound = toolShellEnv(process.env);
		withShellEnv(bound, () => {
			expect(judgedShellEnv()).toBe(bound);
			expect(boundaryEnv()).toBe(bound);
		});
	});
});

describe("every judged spawner: its real shell sees exactly what the check judged", () => {
	beforeEach(() => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		process.env.EIGHT_SHELL_ENV_PASS = "ZZ_BCE_PASSED";
		process.env.ZZ_BCE_PASSED = ws;
		process.env.ZZ_BCE_WITHHELD = ws;
	});

	test("tool executor run_command", async () => {
		const out = String(await new ToolExecutor(ws).execute("run_command", { command: "env" }));
		sameEnv(out, boundaryEnv());
	});

	test("native run_command (keeps the full process environment)", async () => {
		sameEnv(await native("run_command", { command: "env" }), toolShellEnv(process.env));
	});

	test("spawn_agent, shell runtime (keeps the full process environment plus its depth)", async () => {
		const orch = await import("../orchestration");
		const started = await native("spawn_agent", { task: "env", runtime: "shell" });
		const id = JSON.parse(started).agentId as string;
		let stdout: string | undefined;
		for (let i = 0; i < 100 && stdout === undefined; i++) {
			stdout = orch.getCLIAgentStatus(id)?.result?.stdout;
			if (stdout === undefined) await Bun.sleep(100);
		}
		const depth = { [orch.AGENT_DEPTH_ENV]: String(orch.currentAgentDepth() + 1) };
		sameEnv(stdout ?? "", { ...process.env, ...depth });
	});

	test("native background_start", async () => {
		const started = await native("background_start", { command: "env" });
		const id = /Background task started: (\S+)/.exec(started)?.[1];
		expect(id).toBeDefined();
		await native("background_wait", { taskId: id, timeout_s: 30 });
		sameEnv(await native("background_output", { taskId: id }), boundaryEnv());
	});
});

describe("through each real tool, a variable cannot carry a read outside", () => {
	test("tool executor run_command: a name its shell does not get", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		withhold("ZZ_BCE_WITHHELD", ws);
		const out = String(
			await new ToolExecutor(ws).execute("run_command", { command: `cat $ZZ_BCE_WITHHELD${outFile}` }),
		);
		expect(out).not.toContain("OUTSIDE");
		expect(out).toContain("[BLOCKED]");
	});

	test("native run_command: a name only its full-environment shell has", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		withhold("ZZ_BCE_DEEP", path.join(outDir, "deep"));
		const out = await native("run_command", { command: "cat ${ZZ_BCE_DEEP}/../x" });
		expect(out).not.toContain("OUTSIDE-DEEP");
		expect(out).toContain("[BLOCKED]");
	});
});

describe("spawn_agent's shell child: a variable cannot carry a read outside", () => {
	test("a name only its full-environment shell has", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		withhold("ZZ_BCE_DEEP", path.join(outDir, "deep"));
		const out = await native("spawn_agent", { task: "cat ${ZZ_BCE_DEEP}/../x", runtime: "shell" });
		expect(out).not.toContain("agentId");
		expect(out).toContain("[BLOCKED]");
	});
});

describe("spawn_agent's shell child: the workspace write boundary, with a root set", () => {
	beforeEach(() => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		process.env.EIGHT_WORKSPACE_ROOT = ws;
	});

	/** Runs the task through a real spawn_agent; when a child started, waits for it to end. */
	const spawnShell = async (via: "native" | "executor" | "infinite", task: string) => {
		const orch = await import("../orchestration");
		const input = { task, runtime: "shell" };
		let out: string;
		if (via === "native") out = await native("spawn_agent", input);
		else if (via === "executor") out = String(await new ToolExecutor(ws).execute("spawn_agent", input));
		else {
			const { createPermissionHolder, runWithPermissionHolder } = await import("./permission-mode");
			const { spawnAgentTool } = await import("../orchestration/delegation-tools");
			out = await runWithPermissionHolder(createPermissionHolder("infinite"), () =>
				spawnAgentTool(ws, task, "shell"),
			);
		}
		const id = /"agentId": "([^"]+)"/.exec(out)?.[1];
		for (let i = 0; id && i < 100 && !orch.getCLIAgentStatus(id)?.result; i++) await Bun.sleep(100);
		return out;
	};

	// Checked by outcome: the executor rewords a workspace-boundary refusal for the model.
	for (const via of ["native", "executor", "infinite"] as const) {
		test(`${via}: a literal outside write is refused and nothing is written`, async () => {
			const target = path.join(outDir, `lit-${via}`);
			const out = await spawnShell(via, `touch ${target}`);
			expect(out).not.toContain("agentId");
			expect(fs.existsSync(target)).toBe(false);
		});

		test(`${via}: an outside write built from a variable its shell has is refused`, async () => {
			process.env.ZZ_BCE_OUT = outDir;
			const out = await spawnShell(via, `touch $ZZ_BCE_OUT/var-${via}`);
			expect(out).not.toContain("agentId");
			expect(fs.existsSync(path.join(outDir, `var-${via}`))).toBe(false);
		});

		test(`${via}: a write inside the workspace still runs`, async () => {
			const target = path.join(ws, `in-${via}`);
			const out = await spawnShell(via, `touch ${target}`);
			expect(out).toContain("agentId");
			expect(fs.existsSync(target)).toBe(true);
		});
	}
});

describe("a new spawner cannot skip the shared environment", () => {
	const root = path.resolve(import.meta.dir, "..", "..");
	const sources = [...new Bun.Glob("{packages,apps}/**/*.{ts,tsx}").scanSync({ cwd: root })].filter(
		(f) =>
			!/(^|\/)(node_modules|__tests__|fixtures|eval)\//.test(f) &&
			!/\.(test|spec|probe)\.tsx?$/.test(f),
	);
	const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
	/** Each call of `name(` in a file, with the text up to the call's closing line. */
	const calls = (text: string, name: RegExp) =>
		[...text.matchAll(name)].map((m) => {
			const rest = text.slice(m.index);
			const end = rest.indexOf("});");
			return end === -1 ? rest.slice(0, 400) : rest.slice(0, end);
		});

	test("only the known callers judge a shell command; a new one must be added here and given a spawner test", () => {
		const judges = sources
			.filter((f) => /\b(systemOneGate|checkCommandBoundary|extractAndCheckPaths)\(/.test(read(f)))
			.sort();
		expect(judges).toEqual([
			"packages/ai/tools.ts",
			"packages/eight/tools.ts",
			"packages/orchestration/delegation-tools.ts",
			"packages/permissions/policy-engine.ts",
			"packages/permissions/read-boundary.ts",
			"packages/permissions/src/workspace-boundary.ts",
			"packages/permissions/system-one-gate.ts",
		]);
	});

	/**
	 * Every shell launched on text: the judged ones take judgedShellEnv(); the rest run text the
	 * boundary never judges, each with the reason. A new launch fails here until it is one or
	 * the other.
	 */
	const UNJUDGED: Record<string, [count: number, why: string]> = {
		"packages/core/shell.ts": [1, "the spawnShell primitive itself"],
		"apps/tui/src/lib/bang-command.ts": [1, "a `!` command the person typed"],
		"apps/tui/src/lib/external-agent-runner.ts": [1, "a preset install the person chose"],
		"packages/daemon/cron.ts": [2, "scheduled jobs from the gateway; not judged by the boundary"],
		"packages/daemon/routes/store/fs.ts": [1, "fs.exec has its own confinement, minimal env"],
		"packages/hooks/index.ts": [2, "the person's own hook commands"],
		"packages/install-runner/install-runner.ts": [1, "a fixed install recipe"],
		"packages/permissions/sandbox.ts": [1, "runSandboxed has no caller"],
		"packages/skills/experiment.ts": [1, "a skill's own experiment command"],
		"packages/telegram/index.ts": [1, "/run from an allowed Telegram user"],
		"packages/validation/evidence.ts": [1, "fixed evidence commands"],
		"packages/validation/healing.ts": [1, "a configured check command; no importer"],
		"packages/orchestration/universal-spawner.ts": [
			1,
			"the shell runtime's env comes from its caller: delegation-tools passes judgedShellEnv()",
		],
	};

	test("every shell launch takes judgedShellEnv() or is a listed unjudged launch", () => {
		const found: Record<string, number> = {};
		for (const f of sources) {
			for (const call of calls(read(f), /\b(spawnShell|shellInvocation)\((?!command: string)/g)) {
				if (/^\w+\(\s*command: string/.test(call)) continue; // a declaration
				// The tool executor's done-gate branch is the gap the pull request names as not closed.
				if (/\benv: (env === undefined \? )?judgedShellEnv\(\)/.test(call)) continue;
				found[f] = (found[f] ?? 0) + 1;
			}
		}
		const expected = Object.fromEntries(Object.entries(UNJUDGED).map(([f, [n]]) => [f, n]));
		expect(found).toEqual(expected);
	});

	test("the shell runtime's caller binds and passes the judged environment", () => {
		const text = read("packages/orchestration/delegation-tools.ts");
		expect(text).toContain("withShellEnv({ ...process.env, ...depthEnv }");
		expect(text).toContain('env: effectiveRuntime === "shell" ? (judgedShellEnv() as Record<string, string>)');
	});

	test("every route that judges a shell command also meets the run_command policy gate", () => {
		const routes = sources
			.filter((f) => !/^packages\/(permissions|decide\/eval)\//.test(f))
			.filter((f) => /\bsystemOneGate\(/.test(read(f)))
			.sort();
		expect(routes).toEqual([
			"packages/ai/tools.ts",
			"packages/eight/tools.ts",
			"packages/orchestration/delegation-tools.ts",
		]);
		for (const f of routes) expect([f, /\.gate\(/.test(read(f))]).toEqual([f, true]);
		// The shell child: one gate, on both its branches (with and without a permission mode).
		const text = read("packages/orchestration/delegation-tools.ts");
		expect(text).toContain('.gate("primary", "run_command", {');
		expect(text.match(/await runCommandPolicyRefusal\(/g)?.length).toBe(2);
	});
});
