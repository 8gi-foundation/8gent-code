/**
 * #3487: the user-context block (name, role, communication style, language,
 * board briefing) reaches the system prompt the agent actually sends on the
 * local text-tool path too. Before this, the compact local prompt dropped it,
 * so every communication style was a no-op on Ollama, 8gent, LM Studio and
 * llama-server. Measured in the Rishi pilot on 2e779916: the recorded system
 * prompt of every 27B turn held 0 copies of the action-first text.
 *
 * $HOME is faked so the operator's real ~/.8gent/user.json stays out of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent";
import { projectInstructionsSection } from "./instruction-loader";
import { ACTION_FIRST_PRECEDENCE, ACTION_FIRST_STYLE } from "./prompts/system-prompt";

const realHome = process.env.HOME;
let home: string;
let repo: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "uctx3487-home-"));
	repo = mkdtempSync(join(tmpdir(), "uctx3487-repo-"));
	process.env.HOME = home;
	writeFileSync(join(repo, "AGENTS.md"), "# Project rules\n\n- keep it small\n");
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function writeUser(identity: Record<string, unknown>) {
	mkdirSync(join(home, ".8gent"), { recursive: true });
	writeFileSync(
		join(home, ".8gent", "user.json"),
		JSON.stringify({ identity: { language: "en", ...identity }, onboardingComplete: true }),
	);
}

function systemPrompt(runtime: string): string {
	const agent = new Agent({
		model: "m",
		runtime,
		workingDirectory: repo,
	} as ConstructorParameters<typeof Agent>[0]) as unknown as {
		messageHistory: { role: string; content: string }[];
	};
	return agent.messageHistory.find((m) => m.role === "system")?.content ?? "";
}

describe("user context on the local (text-tool) path", () => {
	test("action-first style text and precedence line reach an ollama agent", () => {
		writeUser({ name: "Pilot", communicationStyle: "action-first" });
		const prompt = systemPrompt("ollama");
		expect(prompt.startsWith("You are 8gent, an autonomous coding agent.")).toBe(true);
		expect(prompt).toContain("Communication style: **action-first**.");
		expect(prompt).toContain(ACTION_FIRST_STYLE);
		expect(prompt).toContain(ACTION_FIRST_PRECEDENCE);
	});

	test("it trails the project instructions, so the cached prefix is unchanged (#3222)", () => {
		writeUser({ name: "Pilot", communicationStyle: "action-first" });
		const prompt = systemPrompt("ollama");
		const instructions = projectInstructionsSection(repo, { includeUserGlobal: true });
		expect(instructions.length).toBeGreaterThan(0);
		expect(prompt.indexOf(instructions)).toBeGreaterThan(0);
		expect(prompt.indexOf("## USER CONTEXT")).toBeGreaterThan(prompt.indexOf(instructions));
	});

	test("no style set: no style block on the local path", () => {
		writeUser({ name: "Pilot" });
		const prompt = systemPrompt("ollama");
		expect(prompt).not.toContain("Communication style:");
		expect(prompt).not.toContain(ACTION_FIRST_STYLE);
		expect(prompt).not.toContain(ACTION_FIRST_PRECEDENCE);
	});
});
