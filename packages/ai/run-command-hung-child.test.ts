/**
 * #309: a command the model writes must never hold a turn. Both run_command paths
 * (native agentTools and the text ToolExecutor) give the child no stdin, so a script
 * that reads stdin sees end of file at once, and a command past its limit is stopped
 * with its whole process group and the model is told so.
 *
 * HOME is a throwaway dir, the judge is unreachable and System One is off, so no check
 * depends on a live model or the real ~/.8gent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const saved = {
	HOME: process.env.HOME,
	EIGHT_FAKE_HOME: process.env.EIGHT_FAKE_HOME,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_DECIDE_OLLAMA_HOST: process.env.EIGHT_DECIDE_OLLAMA_HOST,
	OLLAMA_HOST: process.env.OLLAMA_HOST,
	EIGHT_SYSTEM_ONE: process.env.EIGHT_SYSTEM_ONE,
};
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hung-child-home-")));
const project = path.join(home, "project");
fs.mkdirSync(project);
process.env.HOME = home;
process.env.EIGHT_FAKE_HOME = home;
process.env.EIGHT_DATA_DIR = path.join(home, ".8gent-data");
process.env.EIGHT_DECIDE_OLLAMA_HOST = "http://127.0.0.1:9";
process.env.OLLAMA_HOST = "http://127.0.0.1:9";
process.env.EIGHT_SYSTEM_ONE = "0";

type Run = (command: string, timeoutSec?: number) => Promise<string>;
let native: Run;
let text: Run;

beforeAll(async () => {
	const ai = await import("./tools");
	const { ToolExecutor } = await import("../eight/tools");
	native = async (command) => {
		ai.setToolContext({ workingDirectory: project });
		const t = (
			ai.agentTools as unknown as Record<
				string,
				{ execute: (i: unknown, o: unknown) => Promise<unknown> }
			>
		).run_command;
		return String(await t.execute({ command }, { toolCallId: "t", messages: [] }));
	};
	const ex = new ToolExecutor(project, "hung-child");
	const inner = ex as unknown as {
		permissionManager: { checkPermission: () => string };
		hookManager: { executeHooks: () => Promise<undefined> };
	};
	inner.permissionManager.checkPermission = () => "allowed";
	inner.hookManager.executeHooks = async () => undefined;
	text = (command, timeoutSec) => ex.runCommand(command, timeoutSec);
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return !alive(pid);
}

describe("run_command: a command that reads stdin returns at once (#309)", () => {
	for (const [name, run] of [
		["native", () => native],
		["text", () => text],
	] as const) {
		test(`${name} path`, async () => {
			const started = Date.now();
			const out = await run()("cat", 30);
			expect(out).not.toContain("STILL RUNNING");
			expect(Date.now() - started).toBeLessThan(5000);
		}, 20000);
	}
});

describe("run_command: a command past its limit is stopped (#309)", () => {
	test("text path: the model is told, and no process in the group survives", async () => {
		const pidFile = path.join(project, "sleeper.pid");
		const out = await text(`sh -c 'sleep 30 & echo $! > ${pidFile}; wait'`, 1);
		expect(out).toStartWith("TIMEOUT after 1s");
		expect(out).toContain("the command was stopped");
		const sleeper = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
		expect(sleeper).toBeGreaterThan(1);
		expect(await goneWithin(sleeper, 4000)).toBe(true);
	}, 20000);
});
