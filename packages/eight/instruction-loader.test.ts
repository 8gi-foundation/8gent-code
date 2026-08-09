import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions } from "./instruction-loader";

/**
 * These tests fake $HOME so the operator's real ~/.claude/CLAUDE.md is not a
 * hidden input. The bug being locked down here is exactly that: the loader
 * used to look only at ~/.8gent for the global layer, so the standing rules
 * the operator actually maintains in ~/.claude never reached any agent whose
 * cwd had no repo instruction file.
 */
const dirs: string[] = [];
const realHome = process.env.HOME;

function sandboxHome(): string {
	const home = mkdtempSync(join(tmpdir(), "instr-home-"));
	dirs.push(home);
	process.env.HOME = home;
	return home;
}

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

describe("standing rules from ~/.claude/CLAUDE.md", () => {
	test("load even when there is no repo instruction file anywhere", () => {
		const home = sandboxHome();
		write(join(home, ".claude", "CLAUDE.md"), "Boil the Ocean. No hardcoded data.");
		const empty = mkdtempSync(join(tmpdir(), "instr-cwd-"));
		dirs.push(empty);

		const out = loadInstructions(empty);
		expect(out).toContain("STANDING RULES");
		expect(out).toContain("Boil the Ocean");
	});

	test("come first, so a repo file overrides them rather than the other way round", () => {
		const home = sandboxHome();
		write(join(home, ".claude", "CLAUDE.md"), "STANDING-MARKER");
		const project = mkdtempSync(join(tmpdir(), "instr-proj-"));
		dirs.push(project);
		write(join(project, "AGENTS.md"), "PROJECT-MARKER");

		const out = loadInstructions(project);
		expect(out.indexOf("STANDING-MARKER")).toBeLessThan(out.indexOf("PROJECT-MARKER"));
	});

	test("merge alongside the ~/.8gent global layer instead of replacing it", () => {
		const home = sandboxHome();
		write(join(home, ".claude", "CLAUDE.md"), "STANDING-MARKER");
		write(join(home, ".8gent", "AGENTS.md"), "GLOBAL-MARKER");
		const empty = mkdtempSync(join(tmpdir(), "instr-cwd-"));
		dirs.push(empty);

		const out = loadInstructions(empty);
		expect(out).toContain("STANDING-MARKER");
		expect(out).toContain("GLOBAL-MARKER");
		expect(out.indexOf("STANDING-MARKER")).toBeLessThan(out.indexOf("GLOBAL-MARKER"));
	});

	test("an absent file is not an error and adds nothing", () => {
		sandboxHome();
		const empty = mkdtempSync(join(tmpdir(), "instr-cwd-"));
		dirs.push(empty);
		expect(loadInstructions(empty)).toBe("");
	});

	test("an empty file adds no header", () => {
		const home = sandboxHome();
		write(join(home, ".claude", "CLAUDE.md"), "   \n\n");
		const empty = mkdtempSync(join(tmpdir(), "instr-cwd-"));
		dirs.push(empty);
		expect(loadInstructions(empty)).toBe("");
	});
});

describe("regression: the Telegram surface", () => {
	test("an agent running from a repo still gets the standing rules too", () => {
		const home = sandboxHome();
		write(join(home, ".claude", "CLAUDE.md"), "No-BS Mode is always on.");
		const repo = mkdtempSync(join(tmpdir(), "instr-repo-"));
		dirs.push(repo);
		write(join(repo, "AGENTS.md"), "Repo rules.");

		const out = loadInstructions(repo);
		expect(out).toContain("No-BS Mode is always on.");
		expect(out).toContain("Repo rules.");
	});
});
