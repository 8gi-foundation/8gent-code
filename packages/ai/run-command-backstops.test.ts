/**
 * Native run_command shares the text path's pre-spawn backstops (#3993).
 *
 * 8SO proved the native path (agentTools.run_command -> runShellCommand) listed
 * ~/.8gent/browser-profiles where ToolExecutor.runCommand refused. Both paths now
 * call preSpawnRefusal() before anything else, so each refusal is word for word
 * the same and nothing is spawned. HOME is a throwaway dir and the judge is
 * unreachable, so no check depends on a live model or the real ~/.8gent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preSpawnRefusal } from "../permissions/pre-spawn-backstops";
import { REFUSAL_NOTE } from "../permissions/refusal-lead";

const saved = {
	HOME: process.env.HOME,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_DECIDE_OLLAMA_HOST: process.env.EIGHT_DECIDE_OLLAMA_HOST,
	OLLAMA_HOST: process.env.OLLAMA_HOST,
};
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backstops-home-")));
const work = path.join(home, "project");
fs.mkdirSync(work);
fs.mkdirSync(path.join(home, ".8gent", "browser-profiles", "work"), { recursive: true });
fs.writeFileSync(path.join(home, ".8gent", "settings.json"), "{}");
process.env.HOME = home;
process.env.EIGHT_DATA_DIR = path.join(home, ".8gent-data");
process.env.EIGHT_DECIDE_OLLAMA_HOST = "http://127.0.0.1:9";
process.env.OLLAMA_HOST = "http://127.0.0.1:9";

// One command per backstop, each with the refusal both paths must give.
const CASES: { name: string; command: string; starts: string }[] = [
	{
		name: "settings.json (#3595)",
		command: "cat ~/.8gent/settings.json",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Command touches ~/.8gent/settings.json`,
	},
	{
		name: "bot key file (#4594)",
		command: "cat ~/.8gent/secrets/telegram-bot.env",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Command touches ~/.8gent/secrets`,
	},
	{
		name: "audit files (#3735)",
		command: "tail ~/.8gent/audit/today.jsonl",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Command touches agent audit files`,
	},
	{
		name: "session records",
		command: "rm ~/.8gent/sessions/last.json",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Command would change session records`,
	},
	{
		name: "browser profiles (#3622, the 8SO repro)",
		command: "ls ~/.8gent/browser-profiles",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Run it without touching ~/.8gent/browser-* paths: this command reaches 8gent Browser control tokens or profiles`,
	},
	{
		name: "browser control token (#3622)",
		command: "cat ~/.8gent/browser-control.token",
		starts: `[PERMISSION DENIED] ${REFUSAL_NOTE} Run it without touching ~/.8gent/browser-* paths: this command reaches`,
	},
];

type Run = (command: string) => Promise<string>;
let nativeRun: Run;
let textRun: Run;
let nativeGitAdd: Run;

beforeAll(async () => {
	const ai = await import("./tools");
	const { ToolExecutor } = await import("../eight/tools");
	ai.setToolContext({ workingDirectory: work });
	const opts = { toolCallId: "t", messages: [] };
	const exec = (name: "run_command" | "git_add") =>
		ai.agentTools[name].execute as (input: unknown, options: unknown) => Promise<string>;
	nativeRun = (command) => exec("run_command")({ command }, opts);
	nativeGitAdd = (files) => exec("git_add")({ files }, opts);
	const executor = new ToolExecutor(work, "backstops-parity");
	textRun = (command) => executor.runCommand(command);
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

describe("native run_command refuses each backstop before spawn (#3993)", () => {
	for (const c of CASES) {
		test(c.name, async () => {
			const out = await nativeRun(c.command);
			expect(out).toStartWith(c.starts);
			expect(out).toBe(preSpawnRefusal(c.command) as string);
			// Refused, not run: no listing of the fake profile dir leaks through.
			expect(out).not.toContain("\nwork");
		});
	}

	test("the git tools on the native path are covered too", async () => {
		const out = await nativeGitAdd("~/.8gent/settings.json");
		expect(out).toStartWith(
			`[PERMISSION DENIED] ${REFUSAL_NOTE} Command touches ~/.8gent/settings.json`,
		);
	});
});

describe("text and native paths refuse the same commands with the same words (#3993)", () => {
	const list = [
		...CASES.map((c) => c.command),
		"ls -la ~/.8gent/",
		"find ~/.8gent -name '*.token'",
		"cat ~/'.8'gent/browser-control.port",
		"echo x > ~/.8gent/logs/run.log",
		"cat audit.jsonl",
	];
	for (const command of list) {
		test(command, async () => {
			const expected = preSpawnRefusal(command);
			expect(expected).not.toBeNull();
			expect(await nativeRun(command)).toBe(expected as string);
			expect(await textRun(command)).toBe(expected as string);
		});
	}

	test("an ordinary command passes the backstops", () => {
		expect(preSpawnRefusal("ls src")).toBeNull();
		expect(preSpawnRefusal("cat package.json")).toBeNull();
	});
});

describe("the default bot key file is refused to the shell in every spelling (#4594)", () => {
	for (const command of [
		"cat ~/.8gent/secrets/telegram-bot.env",
		"cat $HOME/.8gent/secrets/telegram-bot.env",
		'cat "$HOME/.8gent/secrets/telegram-bot.env"',
		"grep -r TOKEN ~/.8gent/secrets",
		"ls ~/.8gent/secrets",
		"cp ~/.8gent/secrets/x ./x",
		"echo x > ~/.8gent/secrets/telegram-bot.env",
	]) {
		test(command, () => {
			expect(preSpawnRefusal(command, work)).toContain("~/.8gent/secrets");
		});
	}
	test("a neighbour is not caught", () => {
		expect(preSpawnRefusal("ls ~/.8gent/secretary-notes", work)).toBeNull();
	});
});
