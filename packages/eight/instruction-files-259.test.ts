/**
 * #259: a short AGENTS.md must not hide the CLAUDE.md beside it, and the cap
 * must not drop the standing rules whole. The sizes are the ones in the issue.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_INSTRUCTIONS_CAP,
	instructionFileRows,
	projectInstructionsSection,
} from "./instruction-loader";

let home: string;
let repo: string;
let realHome: string | undefined;

const fill = (mark: string, bytes: number) => {
	const line = `- ${mark} rule line\n`;
	return `# ${mark}\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes);
};

beforeEach(() => {
	realHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "instr259-home-"));
	repo = join(home, "work", "repo");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	process.env.HOME = home;
	writeFileSync(join(repo, "AGENTS.md"), fill("GENERATED-NOTE", 400));
	writeFileSync(join(repo, "CLAUDE.md"), fill("PROJECT-RULES", 4096));
	writeFileSync(join(home, ".claude", "CLAUDE.md"), fill("STANDING-RULES", 18 * 1024));
});

afterEach(() => {
	if (realHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

describe("a 400 byte AGENTS.md, a 4 KB CLAUDE.md beside it and 18 KB of standing rules", () => {
	test("text from all three reaches an on-box prompt, under the cap", () => {
		const section = projectInstructionsSection(repo, { includeUserGlobal: true });
		expect(section).toContain("GENERATED-NOTE");
		expect(section).toContain("PROJECT-RULES");
		expect(section).toContain("STANDING-RULES");
		expect(section.length).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_CAP + 120);
		// The two project files are whole; only the standing rules are shortened.
		expect(section).toContain(fill("PROJECT-RULES", 4096).trim());
		expect(section).toContain("1 instruction file(s) shortened to fit");
	});

	test("a cloud prompt carries both project files and none of the operator's own", () => {
		const section = projectInstructionsSection(repo);
		expect(section).toContain("GENERATED-NOTE");
		expect(section).toContain("PROJECT-RULES");
		expect(section).not.toContain("STANDING-RULES");
	});

	test("the doctor rows list all three with what was kept", () => {
		const rows = instructionFileRows(repo);
		expect(rows.map((r) => r.path)).toEqual([
			join(home, ".claude", "CLAUDE.md"),
			join(repo, "AGENTS.md"),
			join(repo, "CLAUDE.md"),
		]);
		const [standing, agents, claude] = rows;
		expect(agents.kept).toBe(agents.chars);
		expect(claude.kept).toBe(claude.chars);
		expect(standing.kept).toBeGreaterThan(1000);
		expect(standing.kept).toBeLessThan(standing.chars);
	});

	test("many large files: every one keeps a beginning", () => {
		let dir = repo;
		for (let i = 0; i < 4; i++) {
			dir = join(dir, `d${i}`);
			mkdirSync(dir);
			writeFileSync(join(dir, "AGENTS.md"), fill(`LEVEL-${i}`, 6000));
		}
		const section = projectInstructionsSection(dir, { includeUserGlobal: true });
		for (const mark of ["STANDING-RULES", "GENERATED-NOTE", "PROJECT-RULES", "LEVEL-0", "LEVEL-3"])
			expect(section).toContain(mark);
		expect(section.length).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_CAP + 120);
	});
});
