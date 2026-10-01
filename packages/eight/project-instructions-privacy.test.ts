/**
 * #3236 follow-up (8SO): user-global instruction files are the operator's own
 * standing rules. They may reach an on-box model, never a cloud provider.
 * Project files reach both.
 *
 * Layout under a fake $HOME:
 *   ~/.claude/CLAUDE.md      standing rules   (user-global)
 *   ~/.8gent/AGENTS.md       global rules     (user-global)
 *   ~/AGENTS.md              home-level file  (user-global: walk-up at or above HOME)
 *   ~/code/repo/AGENTS.md    the project      (project)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWhenReleased } from "../core/open-files";
import { Agent } from "./agent";

const STANDING = "STANDING_SENTINEL_private_operator_rule";
const GLOBAL = "GLOBAL_SENTINEL_eight_dir_rule";
const HOME_LEVEL = "HOME_LEVEL_SENTINEL_home_agents_md";
const PROJECT = "PROJECT_SENTINEL_repo_rule";
const realHome = process.env.HOME;
let home: string;
let repo: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "instr-priv-home-"));
	repo = join(home, "code", "repo");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".8gent"), { recursive: true });
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(home, ".claude", "CLAUDE.md"), `- ${STANDING}\n`);
	writeFileSync(join(home, ".8gent", "AGENTS.md"), `- ${GLOBAL}\n`);
	writeFileSync(join(home, "AGENTS.md"), `- ${HOME_LEVEL}\n`);
	writeFileSync(join(repo, "AGENTS.md"), `- ${PROJECT}\n`);
	process.env.HOME = home;
});

afterAll(async () => {
	// Close the memory databases the agents opened under the temp home first:
	// Windows refuses to delete a directory holding an open file.
	(await import("../memory")).resetMemoryManager();
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	removeWhenReleased(home);
});

function systemPrompt(runtime: string, baseUrl?: string): string {
	const agent = new Agent({
		model: "m",
		runtime,
		workingDirectory: repo,
		...(baseUrl ? { baseUrl } : {}),
	} as ConstructorParameters<typeof Agent>[0]) as unknown as {
		messageHistory: { role: string; content: string }[];
	};
	return agent.messageHistory.find((m) => m.role === "system")?.content ?? "";
}

describe("user-global instructions and the provider", () => {
	for (const runtime of ["anthropic", "openai", "openrouter"]) {
		test(`cloud provider ${runtime}: project rules in, user-global rules never`, () => {
			const prompt = systemPrompt(runtime);
			expect(prompt).toContain(PROJECT);
			expect(prompt).not.toContain(STANDING);
			expect(prompt).not.toContain(GLOBAL);
			expect(prompt).not.toContain(HOME_LEVEL);
		});
	}

	test("local provider ollama: project and user-global rules both in", () => {
		const prompt = systemPrompt("ollama");
		expect(prompt).toContain(PROJECT);
		expect(prompt).toContain(STANDING);
		expect(prompt).toContain(GLOBAL);
		expect(prompt).toContain(HOME_LEVEL);
	});

	test("a local provider pointed off-box counts as cloud", () => {
		const prompt = systemPrompt("ollama", "https://gpu.example.com:11434");
		expect(prompt).toContain(PROJECT);
		expect(prompt).not.toContain(STANDING);
		expect(prompt).not.toContain(GLOBAL);
		expect(prompt).not.toContain(HOME_LEVEL);
	});
});
