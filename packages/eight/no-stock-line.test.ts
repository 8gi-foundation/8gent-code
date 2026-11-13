/**
 * A reply is exactly what the model produced (after the honesty gate): no line
 * from any personality phrase list is added. Drives the shipping chat() path
 * against a fake OpenAI-compatible endpoint, as turn-review-flag.test.ts does.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import * as voice from "../personality/voice";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const pendingDetect: Promise<unknown>[] = [];
let detectSpy: { mockRestore: () => void } | undefined;
const saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof Bun.serve>;
let repo: string;
let replyText = "";
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};

beforeAll(async () => {
	const home = tempDir("nostock-home-");
	repo = tempDir("nostock-repo-");
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	({ Agent } = await import("./agent"));
	const { OnboardingManager } = await import("../self-autonomy/onboarding");
	const realDetect = OnboardingManager.prototype.detectIntegrations;
	detectSpy = spyOn(OnboardingManager.prototype, "detectIntegrations").mockImplementation(function (
		this: InstanceType<typeof OnboardingManager>,
		...args: Parameters<typeof realDetect>
	) {
		const p = realDetect.apply(this, args);
		pendingDetect.push(p.catch(() => {}));
		return p;
	});
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			return Response.json({
				id: "c",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: replyText },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await Promise.allSettled(pendingDetect);
	detectSpy?.mockRestore();
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	cleanupTempDirs();
});

const ALL_PHRASES = Object.values(voice)
	.filter((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"))
	.flat();

describe("no stock line on any reply", () => {
	test("phrase lists exist to check against", () => {
		expect(ALL_PHRASES.length).toBeGreaterThan(10);
	});

	test("50 turns come back byte-identical, with and without a bare-reply request", async () => {
		const agent: AgentT = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
		} as ConstructorParameters<typeof Agent>[0]);
		replyText = "The parser now rejects empty input.";
		const spy = spyOn(console, "log").mockImplementation(() => {});
		try {
			for (let i = 0; i < 50; i++) {
				const prompt = i % 2 === 0 ? "Explain the parser change" : "Reply with just the summary";
				const reply = await agent.chat(prompt);
				expect(reply).toBe(replyText);
				for (const p of ALL_PHRASES) expect(reply).not.toContain(p);
			}
		} finally {
			spy.mockRestore();
		}
	}, 120_000);
});

describe("the system prompt asks for no stock phrase", () => {
	test("the personality segment carries no phrase from any list and no instruction to use one", () => {
		// A native-tool runtime gets the full prompt, personality block included.
		process.env.EIGHT_TEXT_TOOLS = "0";
		let agent: AgentT;
		try {
			agent = new Agent({
				model: "m",
				runtime: "openrouter",
				workingDirectory: repo,
				baseUrl: `http://127.0.0.1:${server.port}`,
			} as ConstructorParameters<typeof Agent>[0]);
		} finally {
			process.env.EIGHT_TEXT_TOOLS = ENV.EIGHT_TEXT_TOOLS;
		}
		const segments = (agent as unknown as { systemSegments: [string, string][] }).systemSegments;
		const personality = segments.find(([name]) => name === "personality")?.[1] ?? "";
		expect(personality).toContain("PERSONALITY VOICE");
		const prompt = segments.map(([, t]) => t).join("");
		expect(prompt).not.toMatch(/use phrases like/i);
		// The stock greeting, completion, error, idle, thinking and progress lines.
		const stock = [
			...voice.GREETINGS,
			...voice.COMPLETION_PHRASES,
			...voice.ERROR_PHRASES,
			...voice.IDLE_QUIPS,
			...voice.THINKING_PHRASES,
			...voice.PROGRESS_PHRASES,
		];
		for (const p of stock) expect(prompt).not.toContain(p);
	});
});
