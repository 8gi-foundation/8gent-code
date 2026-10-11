import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	completionSelfCheckEnabled,
	completionSelfCheckNudge as nudge,
	deliverableFiles,
	gitSnapshot,
} from "./completion-selfcheck";

const wrote = [{ name: "write_file", success: true }];
const repo = () => {
	const d = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "selfcheck-"));
	execFileSync("git", ["init", "-q"], { cwd: d });
	return d;
};
const run = (task: string, cwd: string, extra: object = {}) =>
	nudge({ task, cwd, ledger: wrote, gitBaseline: gitSnapshot(cwd), ...extra });

describe("completion self-check", () => {
	test("flag defaults on, =0 off", () => {
		expect(completionSelfCheckEnabled({})).toBe(true);
		expect(completionSelfCheckEnabled({ EIGHT_COMPLETION_SELFCHECK: "0" })).toBe(false);
		const d = repo();
		expect(run("Write x.md", d, { env: { EIGHT_COMPLETION_SELFCHECK: "0" } })).toBeNull();
	});

	test("must-fix 1: commit check is scoped to the turn", () => {
		const d = repo();
		writeFileSync(path.join(d, "old.txt"), "dirt from before");
		const baseline = gitSnapshot(d);
		const task = "Implement it and commit the work";
		expect(nudge({ task, cwd: d, ledger: wrote, gitBaseline: baseline })).toBeNull();
		writeFileSync(path.join(d, "e2e.json"), "{}");
		const n = nudge({ task, cwd: d, ledger: wrote, gitBaseline: baseline });
		expect(n).toContain('"?? e2e.json"');
		expect(n).not.toContain("old.txt");
		expect(n).not.toContain("or remove");
		writeFileSync(path.join(d, "old.txt"), "edited during the turn, longer");
		expect(nudge({ task, cwd: d, ledger: wrote, gitBaseline: baseline })).toContain("old.txt");
	});

	test("must-fix 1: only an imperative ask to commit counts", () => {
		const d = repo();
		const base = gitSnapshot(d);
		writeFileSync(path.join(d, "new.txt"), "x");
		for (const t of [
			"Review the last commit and fix the typo",
			"Fix the commit message wording",
			"Explain the previous commit",
			"Read the commit history",
			"Implement it, do not commit",
		])
			expect(nudge({ task: t, cwd: d, ledger: wrote, gitBaseline: base })).toBeNull();
		expect(nudge({ task: "Fix it and commit.", cwd: d, ledger: wrote, gitBaseline: base })).toContain("new.txt");
	});

	test("must-fix 2: URLs, ~, framework names, removed files, verb word boundary", () => {
		expect(deliverableFiles("Write a doc, see https://example.com/a/page.html and www.foo.org/x.md")).toEqual([]);
		expect(deliverableFiles("Create a Node.js and Next.js app using Three.js")).toEqual([]);
		expect(deliverableFiles("Deploy to production and read config.json")).toEqual([]);
		expect(deliverableFiles("Create app/Vue.js")).toEqual(["app/Vue.js"]);
		expect(deliverableFiles("Rename old.md and create new.md.")).toEqual([]);
		const d = repo();
		const del = [...wrote, { name: "delete_file", success: true, args: { path: "tmp.txt" } }];
		expect(nudge({ task: "Create tmp.txt then tidy up", cwd: d, ledger: del })).toBeNull();
		expect(nudge({ task: "Create tmp.txt then tidy up", cwd: d, ledger: wrote })).toContain("tmp.txt");
	});

	test("must-fix 3: paths outside the workspace are skipped; ~ is expanded then confined", () => {
		const d = repo();
		expect(run("Save the notes to /etc/missing-notes.txt", d)).toBeNull();
		expect(run("Write ../elsewhere/out.txt", d)).toBeNull();
		expect(run("Save it to ~/never-exists-l18.txt", d)).toBeNull();
		expect(run("Write sub/out.txt", d)).toContain("sub/out.txt");
		writeFileSync(path.join(d, "ok.txt"), "x");
		expect(run("Write ok.txt", d)).toBeNull();
	});

	test("tests asked but never run is flagged; a test run satisfies it", () => {
		const d = repo();
		const task = "Fix the bug and run the tests";
		expect(run(task, d)).toContain("no test command");
		const ran = [...wrote, { name: "run_command", success: true, args: { command: "bun test" } }];
		expect(nudge({ task, cwd: d, ledger: ran })).toBeNull();
	});

	test("silent when nothing was done, no baseline for commit, or oversized task", () => {
		const d = repo();
		writeFileSync(path.join(d, "n.txt"), "x");
		expect(nudge({ task: "Write x.md", cwd: d, ledger: [] })).toBeNull();
		expect(nudge({ task: "and commit the work", cwd: d, ledger: wrote })).toBeNull();
		expect(run("a ".repeat(20000) + "Write late.md", d)).toBeNull();
	});
});
