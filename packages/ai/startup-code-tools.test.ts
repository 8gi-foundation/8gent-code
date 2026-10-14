/**
 * 8SO F2 (#4009): write_file, edit_file and run_command cannot plant code in what 8gent
 * runs at start (~/.8gent/hooks.yaml, hooks.json, extensions/, prompts/, packages/), on
 * the native path (packages/ai agentTools) and the text path (ToolExecutor).
 *
 * The workspace is HOME itself, so the workspace boundary does not refuse first: the
 * path guard and the pre-spawn backstop are what is under test. HOME is a throwaway dir
 * and the judge is unreachable, so nothing here touches the real ~/.8gent or a model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preSpawnRefusal } from "../permissions/pre-spawn-backstops";
import { REFUSAL_NOTE } from "../permissions/refusal-lead";

const saved = {
	HOME: process.env.HOME,
	EIGHT_FAKE_HOME: process.env.EIGHT_FAKE_HOME,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_HOOKS_YAML: process.env.EIGHT_HOOKS_YAML,
	EIGHT_DECIDE_OLLAMA_HOST: process.env.EIGHT_DECIDE_OLLAMA_HOST,
	OLLAMA_HOST: process.env.OLLAMA_HOST,
};
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "startup-tools-home-")));
const dot = path.join(home, ".8gent");
for (const d of ["extensions/ext1", "prompts", "packages"])
	fs.mkdirSync(path.join(dot, d), { recursive: true });
const ORIGINAL = "- event: never\n";
fs.writeFileSync(path.join(dot, "hooks.yaml"), ORIGINAL);
fs.writeFileSync(path.join(dot, "hooks.json"), ORIGINAL);
fs.writeFileSync(path.join(dot, "extensions", "ext1", "index.ts"), ORIGINAL);
fs.writeFileSync(path.join(dot, "prompts", "system.md"), ORIGINAL);
fs.writeFileSync(path.join(dot, "packages", "8gent-packages.lock"), ORIGINAL);
fs.writeFileSync(path.join(home, "evil.ts"), "x");
const project = path.join(home, "project");
fs.mkdirSync(path.join(project, ".8gent"), { recursive: true });
process.env.HOME = home;
process.env.EIGHT_FAKE_HOME = home;
process.env.EIGHT_DATA_DIR = path.join(home, ".8gent-data");
delete process.env.EIGHT_HOOKS_YAML;
process.env.EIGHT_DECIDE_OLLAMA_HOST = "http://127.0.0.1:9";
process.env.OLLAMA_HOST = "http://127.0.0.1:9";

/** Existing files under ~/.8gent the tools must not change. */
const EXISTING = [
	".8gent/hooks.yaml",
	".8gent/hooks.json",
	".8gent/extensions/ext1/index.ts",
	".8gent/prompts/system.md",
	".8gent/packages/8gent-packages.lock",
];
/** New files the tools must not create. */
const NEW = [
	".8gent/extensions/evil/index.ts",
	".8gent/prompts/evil.md",
	".8gent/packages/evil/index.js",
];

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;
let native: Call;
let text: (cwd: string) => Call;
let nativeIn: (cwd: string) => Call;

beforeAll(async () => {
	const ai = await import("./tools");
	const { ToolExecutor } = await import("../eight/tools");
	const opts = { toolCallId: "t", messages: [] };
	nativeIn = (cwd) => async (name, args) => {
		ai.setToolContext({ workingDirectory: cwd });
		const t = (
			ai.agentTools as unknown as Record<
				string,
				{ execute: (i: unknown, o: unknown) => Promise<unknown> }
			>
		)[name];
		try {
			return String(await t.execute(args, opts));
		} catch (err) {
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	};
	native = nativeIn(home);
	text = (cwd) => async (name, args) => {
		const ex = new ToolExecutor(cwd, "startup-code");
		try {
			return name === "run_command"
				? await ex.runCommand(String(args.command))
				: await ex.execute(name, args);
		} catch (err) {
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	};
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

function unchanged() {
	for (const rel of EXISTING) expect(fs.readFileSync(path.join(home, rel), "utf-8")).toBe(ORIGINAL);
	for (const rel of NEW) expect(fs.existsSync(path.join(home, rel))).toBe(false);
}

const paths = () => [
	{ name: "native", call: native },
	{ name: "text", call: text(home) },
];

describe("write_file and edit_file are refused on both paths (#4009)", () => {
	for (const rel of [...EXISTING, ...NEW]) {
		for (const spelling of [`~/${rel}`, rel]) {
			test(`write_file ${spelling}`, async () => {
				for (const p of paths()) {
					const out = await p.call("write_file", { path: spelling, content: "evil" });
					expect(out).toContain("protected 8gent startup code");
				}
				unchanged();
			});
		}
	}

	for (const rel of EXISTING) {
		test(`edit_file ~/${rel}`, async () => {
			for (const p of paths()) {
				const out = await p.call("edit_file", {
					path: `~/${rel}`,
					oldText: "never",
					newText: "evil",
				});
				expect(out).toContain("protected 8gent startup code");
			}
			unchanged();
		});
	}

	test("read_file still reads them", async () => {
		for (const p of paths()) {
			for (const rel of EXISTING) {
				expect(await p.call("read_file", { path: rel })).toContain("event: never");
			}
		}
	});
});

describe("run_command writes are refused on both paths, before spawn (#4009)", () => {
	const COMMANDS = [
		"echo evil > ~/.8gent/hooks.yaml",
		"echo evil >> $HOME/.8gent/hooks.json",
		"cp evil.ts ~/.8gent/extensions/ext1/index.ts",
		"mkdir -p ~/.8gent/extensions/evil && cp evil.ts ~/.8gent/extensions/evil/index.ts",
		"mv evil.ts ~/.8gent/prompts/evil.md",
		"echo evil | tee ~/.8gent/packages/8gent-packages.lock",
		"ln -s $HOME/evil.ts ~/.8gent/extensions/evil",
		"cd ~/.8gent && echo evil > hooks.yaml",
		"echo evil > ./.8gent/hooks.yaml",
		// #3952 narrowed the browser-secret check: a browser-named path under a
		// startup dir is no longer refused by that check, so this one must hold.
		"cp evil.ts ~/.8gent/extensions/browser-helper/index.ts",
		"echo evil > ~/.8gent/prompts/browser.md",
		"mkdir -p ~/.8gent/packages/browser && cp evil.ts ~/.8gent/packages/browser/x.js",
	];
	for (const command of COMMANDS) {
		test(command, async () => {
			const expected = preSpawnRefusal(command, home);
			expect(expected).toStartWith(
				`[PERMISSION DENIED] ${REFUSAL_NOTE} Command would change 8gent hooks, extensions, prompts or packages`,
			);
			expect(await native("run_command", { command })).toBe(expected as string);
			expect(await text(home)("run_command", { command })).toBe(expected as string);
			unchanged();
		});
	}

	test("reads through the shell are not refused by the backstop", () => {
		for (const c of [
			"cat ~/.8gent/hooks.yaml",
			"head ~/.8gent/prompts/system.md",
			"cp ~/.8gent/hooks.yaml backup.yaml",
		]) {
			expect(preSpawnRefusal(c, home)).toBeNull();
		}
	});
});

describe("a project-local .8gent/ is not affected (#4009)", () => {
	test("write_file into the project's own .8gent/ works on both paths", async () => {
		for (const [name, call] of [
			["native", nativeIn(project)],
			["text", text(project)],
		] as const) {
			const out = await call("write_file", { path: `.8gent/hooks.yaml`, content: name });
			expect(out).not.toContain("protected 8gent startup code");
			expect(fs.readFileSync(path.join(project, ".8gent", "hooks.yaml"), "utf-8")).toBe(name);
		}
		unchanged();
	});

	test("the backstop passes a project-local .8gent/ write", () => {
		expect(preSpawnRefusal("echo x > .8gent/hooks.yaml", project)).toBeNull();
		expect(preSpawnRefusal("cp a.ts .8gent/extensions/a.ts", project)).toBeNull();
	});
});

// The shared commandRefusal gate (#4001) judges every shell and argv command in the
// tool's working directory, not process.cwd(): a relative path or a git write is
// resolved where the command will actually run.
describe("the startup-code check resolves against the tool's working directory (#4009, #4001)", () => {
	const DENIED = `[PERMISSION DENIED] ${REFUSAL_NOTE} Command would change 8gent hooks, extensions, prompts or packages`;
	const ext = path.join(dot, "extensions", "ext1");

	test("process.cwd() is outside the fake home, so the two judgements differ", () => {
		expect(fs.realpathSync(process.cwd()).startsWith(home)).toBe(false);
		expect(preSpawnRefusal("echo evil > hooks.yaml", process.cwd())).toBeNull();
		expect(preSpawnRefusal("git checkout main", process.cwd())).toBeNull();
		expect(preSpawnRefusal("echo evil > hooks.yaml", dot)).toStartWith(DENIED);
		expect(preSpawnRefusal("git checkout main", ext)).toStartWith(DENIED);
	});

	test("shell path: a relative write run from ~/.8gent is refused on both tool paths", async () => {
		const command = "echo evil > hooks.yaml";
		expect(await nativeIn(dot)("run_command", { command })).toStartWith(DENIED);
		expect(await text(dot)("run_command", { command })).toStartWith(DENIED);
		unchanged();
	});

	test("shell path: git checkout inside an extension dir is refused", async () => {
		const command = "git checkout main";
		expect(await nativeIn(ext)("run_command", { command })).toStartWith(DENIED);
		expect(await text(ext)("run_command", { command })).toStartWith(DENIED);
		unchanged();
	});

	test("argv path: the native git tools are judged in the working directory too", async () => {
		expect(await nativeIn(ext)("git_checkout", { branch: "main" })).toStartWith(DENIED);
		expect(await nativeIn(ext)("git_create_branch", { branch: "evil" })).toStartWith(DENIED);
		expect(await nativeIn(dot)("git_checkout", { branch: "main" })).toStartWith(DENIED);
		unchanged();
	});
});
