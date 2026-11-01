import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../../tests/rm-retry";
import { Agent } from "../agent";
import { workingProjectNote } from "./system-prompt";

// #4381: agent.ts must append the working-project note on every prompt path.
const realHome = process.env.HOME;
const realOllama = process.env.OLLAMA_HOST;
let home: string;
let base: string;
let repo: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "wpn4381-home-"));
	base = mkdtempSync(join(tmpdir(), "wpn4381-repo-"));
	repo = join(base, "invoice-tool");
	mkdirSync(repo);
	process.env.HOME = home;
	process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realOllama === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = realOllama;
	rmRetry(home);
	rmRetry(base);
});

type Inner = {
	messageHistory: { role: string; content: string }[];
	offBoxSystemPrompt: (() => string) | null;
};
const build = (runtime: string, extra: Record<string, unknown> = {}) =>
	new Agent({ model: "m", runtime, workingDirectory: repo, ...extra } as ConstructorParameters<
		typeof Agent
	>[0]) as unknown as Inner;
const system = (a: Inner) => a.messageHistory.find((m) => m.role === "system")?.content ?? "";

describe("working project note on each prompt path (#4381)", () => {
	const note = () => workingProjectNote(repo);

	test("native path", () => {
		expect(system(build("anthropic"))).toContain(note());
	});

	test("compact local path", () => {
		expect(system(build("ollama"))).toContain(note());
	});

	test("off-box variant of the local path", () => {
		const a = build("ollama");
		expect(a.offBoxSystemPrompt).not.toBeNull();
		expect(a.offBoxSystemPrompt?.()).toContain(note());
	});

	test("a Table officer prompt stays verbatim, no note", () => {
		const a = build("ollama", { agentScope: "__table__", systemPrompt: "OFFICER PERSONA" });
		expect(system(a)).not.toContain("Working project");
	});

	test("working on 8gent-code itself says so instead of denying it", () => {
		const own = workingProjectNote("/Users/x/8gent-code");
		expect(own).toContain("`8gent-code`");
		expect(own).not.toContain("is not this project");
		expect(workingProjectNote("/Users/x/other")).toContain("is not this project");
	});
});
