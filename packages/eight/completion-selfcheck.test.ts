import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	completionSelfCheckEnabled,
	completionSelfCheckNudge,
	deliverableFiles,
} from "./completion-selfcheck";

const on = { EIGHT_COMPLETION_SELFCHECK: "1" };
const wrote = [{ name: "write_file", success: true }];
const repo = () => {
	const d = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "selfcheck-"));
	execFileSync("git", ["init", "-q"], { cwd: d });
	return d;
};

describe("completion self-check", () => {
	test("flag", () => {
		expect(completionSelfCheckEnabled({})).toBe(true);
		expect(completionSelfCheckEnabled(on)).toBe(true);
		expect(completionSelfCheckEnabled({ EIGHT_COMPLETION_SELFCHECK: "0" })).toBe(false);
	});
	test("extracts files only from creating sentences, skips versions and domains", () => {
		expect(deliverableFiles("Create `out/report.md` and save notes.txt. Use node 20.1.2 and 8gent.dev")).toEqual(
			["out/report.md", "notes.txt"],
		);
		expect(deliverableFiles("Read src/a.ts please")).toEqual([]);
	});
	test("missing named file is flagged, present file is not", () => {
		const d = repo();
		const task = "Write the summary to summary.md";
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: wrote, env: on })).toContain("summary.md");
		writeFileSync(path.join(d, "summary.md"), "x");
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: wrote, env: on })).toBeNull();
	});
	test("commit asked and tree dirty is flagged; clean or not asked is not", () => {
		const d = repo();
		writeFileSync(path.join(d, "e2e.json"), "{}");
		const task = "Implement it and commit the work";
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: wrote, env: on })).toContain("e2e.json");
		expect(completionSelfCheckNudge({ task: "Implement it, do not commit", cwd: d, ledger: wrote, env: on })).toBeNull();
		expect(completionSelfCheckNudge({ task: "Implement it", cwd: d, ledger: wrote, env: on })).toBeNull();
	});
	test("tests asked but never run is flagged; a test run satisfies it", () => {
		const d = repo();
		const task = "Fix the bug and run the tests";
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: wrote, env: on })).toContain("no test command");
		const ran = [...wrote, { name: "run_command", success: true, args: { command: "bun test" } }];
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: ran, env: on })).toBeNull();
	});
	test("silent when off, outside git, or when nothing was done", () => {
		const d = repo();
		const task = "Write x.md and commit and run the tests";
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: wrote, env: { EIGHT_COMPLETION_SELFCHECK: "0" } })).toBeNull();
		expect(completionSelfCheckNudge({ task, cwd: d, ledger: [], env: on })).toBeNull();
		expect(completionSelfCheckNudge({ task: "Explain what a commit is", cwd: d, ledger: wrote, env: on })).toBeNull();
	});
});
