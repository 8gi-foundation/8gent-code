/**
 * #5040: the thinking level reaches the model request and the status line.
 * Text-tool path (ollama) against a fake OpenAI-compatible endpoint; $HOME is faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import type { Agent as AgentT } from "./agent";
import type { TurnThinking } from "./types";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Array<Record<string, unknown>> = [];
let reply: () => string = () => "Done.";

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "think5040-home-"));
	repo = mkdtempSync(join(tmpdir(), "think5040-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Record<string, unknown>);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: reply() }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	removeDir(home);
	removeDir(repo);
});

function build(events: Record<string, unknown> = {}): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns: 4,
		events,
	} as ConstructorParameters<typeof Agent>[0]);
}

const settings = (thinking: Record<string, string>) =>
	writeFileSync(join(home, ".8gent", "settings.json"), JSON.stringify({ thinking }));

describe("#5040 thinking level per turn", () => {
	test("an easy ask is fast: low, sent as no-thinking, shown on the event", async () => {
		bodies = [];
		const seen: TurnThinking[] = [];
		const agent = build({ onThinking: (e: TurnThinking) => seen.push(e) });
		await agent.chat("what is in this folder");
		expect(bodies[0].reasoning_effort).toBe("none");
		expect(agent.getLastThinking()).toMatchObject({ level: "low", source: "auto", applied: true });
		expect(seen.at(-1)?.level).toBe("low");
	});

	test("a design ask steps up one level, then the next ask is low again", async () => {
		bodies = [];
		const agent = build();
		await agent.chat("design the plug architecture across packages");
		expect(bodies[0].reasoning_effort).toBe("medium");
		expect(agent.getLastThinking()?.signals).toEqual(["plan-or-design"]);
		await agent.chat("now say hello in one word");
		expect(agent.getLastThinking()?.level).toBe("low");
	});

	test("setThinkingLevel fixes the level; off sends nothing; auto hands it back", async () => {
		bodies = [];
		const agent = build();
		agent.setThinkingLevel("high");
		await agent.chat("what is in this folder");
		expect(bodies[0].reasoning_effort).toBe("high");
		expect(agent.getLastThinking()).toMatchObject({ level: "high", source: "fixed" });
		agent.setThinkingLevel("off");
		await agent.chat("what is in this folder");
		expect(bodies[1]).not.toHaveProperty("reasoning_effort");
		agent.setThinkingLevel("auto");
		expect(agent.getThinkingLevel()).toBe("auto");
	});

	test("the owner's cap holds the decider down", async () => {
		bodies = [];
		settings({ level: "auto", cap: "low" });
		const agent = build();
		await agent.chat("think hard and design the cache");
		expect(bodies[0].reasoning_effort).toBe("none");
		expect(agent.getLastThinking()).toMatchObject({ level: "low", capped: true });
		writeFileSync(join(home, ".8gent", "settings.json"), "{}");
	});

	test("two failed turns in a row step the next turn up", async () => {
		bodies = [];
		reply = () => "";
		const agent = build();
		await agent.chat("fix the failing build");
		await agent.chat("fix the failing build");
		reply = () => "Done.";
		await agent.chat("fix the failing build");
		expect(agent.getLastThinking()?.signals).toContain("repeat-failure");
	});
});
