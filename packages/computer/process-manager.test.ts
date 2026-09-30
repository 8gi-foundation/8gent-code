/**
 * desktop_quit_app never hands a model-supplied app name to a shell (#3213).
 *
 * quitByName used to run `pkill -15 -x "<name>"` through execSync with only
 * double quotes stripped, so `$(...)` and backticks in the name ran as the
 * user. It now matches the name exactly against the running process list and
 * signals each matching PID directly; nothing is ever spawned through a shell.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quitByName } from "./process-manager";

const dir = mkdtempSync(join(tmpdir(), "quit-by-name-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("quitByName never reaches a shell", () => {
	const cases: [string, (marker: string) => string][] = [
		["command substitution $(...)", (m) => `Safari$(touch ${m})`],
		["backticks", (m) => `Safari\`touch ${m}\``],
		["semicolon", (m) => `Safari; touch ${m}`],
		["quote break-out", (m) => `Safari"; touch ${m}; echo "`],
		["newline", (m) => `Safari\ntouch ${m}`],
	];

	for (const [label, build] of cases) {
		test(`an app name with ${label} runs nothing`, () => {
			const marker = join(dir, `pwned-${label.replace(/\W+/g, "-")}`);
			const result = quitByName(build(marker), "graceful");
			expect(existsSync(marker)).toBe(false);
			// No running process has that exact name, so nothing is quit.
			expect(result.ok).toBe(false);
		});
	}

	test("the module no longer imports execSync (argument arrays only)", () => {
		const src = readFileSync(join(import.meta.dir, "process-manager.ts"), "utf-8");
		expect(src).not.toMatch(/\bexecSync\b/);
	});

	test("an empty name quits nothing", () => {
		expect(quitByName("   ").ok).toBe(false);
	});

	test("a system-critical name is still refused", () => {
		const r = quitByName("launchd");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("system-critical");
	});
});

describe("quitByName quits the exact running process", () => {
	let child: ChildProcess | undefined;
	afterAll(() => {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});

	test("a uniquely named process is found by exact name and receives SIGTERM", async () => {
		// A symlink to sleep under a unique name: ps reports the unique name, so
		// the test can only ever signal its own child.
		const name = `q8t${process.pid}`.slice(0, 15);
		const bin = join(dir, name);
		symlinkSync("/bin/sleep", bin);
		child = spawn(bin, ["30"], { stdio: "ignore" });
		const exited = new Promise<NodeJS.Signals | null>((resolve) =>
			child?.on("exit", (_code, signal) => resolve(signal)),
		);
		// Wait until ps can see it.
		await new Promise((r) => setTimeout(r, 200));

		// A prefix of the name is not a match: exact names only.
		expect(quitByName(name.slice(0, -1)).ok).toBe(false);

		const result = quitByName(name, "graceful");
		expect(result).toEqual({ ok: true });
		expect(await exited).toBe("SIGTERM");
	});
});
