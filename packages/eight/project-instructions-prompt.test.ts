/**
 * #3236: a project's AGENTS.md reaches the system prompt the agent actually
 * sends, on both the local (compact) and the native (full) path, as the
 * trailing section (#3222). Before this, loadInstructions found the file and
 * it reached 0 of 18 built prompts.
 *
 * $HOME is faked so the operator's real ~/.claude/CLAUDE.md and ~/.8gent stay
 * out of the test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent";
import { PROJECT_INSTRUCTIONS_CAP, projectInstructionsSection } from "./instruction-loader";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

const SENTINEL = "SENTINEL_3236_always_run_bun_test_before_pushing";
const realHome = process.env.HOME;
let home: string;
let repo: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "instr3236-home-"));
	repo = mkdtempSync(join(tmpdir(), "instr3236-repo-"));
	process.env.HOME = home;
	writeFileSync(join(repo, "AGENTS.md"), `# Project rules\n\n- ${SENTINEL}\n`);
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function systemPrompt(runtime: string, extra: Record<string, unknown> = {}): string {
	const agent = new Agent({
		model: "m",
		runtime,
		workingDirectory: repo,
		...extra,
	} as ConstructorParameters<typeof Agent>[0]) as unknown as {
		messageHistory: { role: string; content: string }[];
	};
	return agent.messageHistory.find((m) => m.role === "system")?.content ?? "";
}

describe("project AGENTS.md in the live system prompt", () => {
	test("local path (compact prompt) carries it as the trailing section", () => {
		const prompt = systemPrompt("ollama");
		expect(prompt.startsWith("You are 8gent, an autonomous coding agent.")).toBe(true);
		expect(prompt).toContain(SENTINEL);
		expect(prompt.endsWith(projectInstructionsSection(repo))).toBe(true);
	});

	test("native path (full prompt) carries it as the trailing section", () => {
		const prompt = systemPrompt("anthropic");
		expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
		expect(prompt).toContain(SENTINEL);
		expect(prompt.endsWith(projectInstructionsSection(repo))).toBe(true);
	});

	test("a Table officer keeps its supplied prompt verbatim", () => {
		const prompt = systemPrompt("ollama", {
			agentScope: "__table__",
			systemPrompt: "OFFICER PERSONA",
		});
		expect(prompt).not.toContain(SENTINEL);
	});
});

describe("projectInstructionsSection cap", () => {
	test("a lower-priority file is left out before the project's own file is cut", () => {
		const globalDir = join(home, ".8gent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "AGENTS.md"), "global rule\n".repeat(2000));
		try {
			const section = projectInstructionsSection(repo);
			expect(section.length).toBeLessThan(PROJECT_INSTRUCTIONS_CAP + 200);
			expect(section).toContain(SENTINEL);
			expect(section).not.toContain("global rule");
			expect(section).toContain("1 lower-priority instruction file(s) left out");
		} finally {
			rmSync(globalDir, { recursive: true, force: true });
		}
	});

	test("a project file over the cap keeps its beginning", () => {
		const big = mkdtempSync(join(tmpdir(), "instr3236-big-"));
		try {
			writeFileSync(join(big, "AGENTS.md"), `- ${SENTINEL}\n${"filler line\n".repeat(2000)}`);
			const section = projectInstructionsSection(big);
			expect(section.length).toBeLessThan(PROJECT_INSTRUCTIONS_CAP + 200);
			expect(section).toContain(SENTINEL);
			expect(section).toContain("truncated");
		} finally {
			rmSync(big, { recursive: true, force: true });
		}
	});

	test("no instruction files, no section", () => {
		const empty = mkdtempSync(join(tmpdir(), "instr3236-empty-"));
		try {
			expect(projectInstructionsSection(empty)).toBe("");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
