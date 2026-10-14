/**
 * #4287: on the native tool path, a prompt's attached image reaches a model
 * that can see as an image part on the prompt's user message, instead of
 * going to the local VisionInterpreter (which, with no local vision model,
 * fails and leaves the model probing the file with scripts).
 *
 * The pure helpers are tested directly; the shipping chat() native path is
 * driven against a fake OpenAI-compatible endpoint and the request body is
 * asserted. $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { nativePromptSeesImage, withPromptImage } from "./agent";

// 1x1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe("nativePromptSeesImage", () => {
	test("a declared provider that says it sees images is believed, whatever the model name", () => {
		expect(
			nativePromptSeesImage({ declared: true, supportsVision: true }, "qwen/qwen3.8-27b"),
		).toBe(true);
	});
	test("a built-in vision flag alone does not attach to a text-only model", () => {
		expect(
			nativePromptSeesImage({ declared: false, supportsVision: true }, "some/text-model"),
		).toBe(false);
		expect(
			nativePromptSeesImage({ declared: true, supportsVision: false }, "some/text-model"),
		).toBe(false);
		expect(nativePromptSeesImage(undefined, "some/text-model")).toBe(false);
	});
	test("a known vision family attaches on any provider", () => {
		expect(nativePromptSeesImage(undefined, "llava:7b")).toBe(true);
		expect(nativePromptSeesImage({ declared: false, supportsVision: true }, "gpt-4o")).toBe(true);
	});
});

describe("withPromptImage", () => {
	const msgs = [
		{ role: "user" as const, content: "earlier" },
		{ role: "assistant" as const, content: "ok" },
		{ role: "user" as const, content: "Where do I click?" },
		{ role: "user" as const, content: "harness note" },
	];
	test("the image rides on the prompt message, not the note after it", () => {
		const out = withPromptImage(msgs, "Where do I click?", DATA_URL);
		expect(out[2].content).toEqual([
			{ type: "text", text: "Where do I click?" },
			{ type: "image", image: PNG_B64, mediaType: "image/png" },
		]);
		expect(out[3].content).toBe("harness note");
		expect(msgs[2].content).toBe("Where do I click?");
	});
	test("no prompt match: the last user message takes it", () => {
		const out = withPromptImage(msgs, "not present", DATA_URL);
		expect(Array.isArray(out[3].content)).toBe(true);
		expect(out[2].content).toBe("Where do I click?");
	});
	test("no image, or not a data URL: messages unchanged", () => {
		expect(withPromptImage(msgs, "Where do I click?", null)).toBe(msgs);
		expect(withPromptImage(msgs, "Where do I click?", "https://x/y.png")).toBe(msgs);
	});
});

let Agent: typeof import("./agent").Agent;
type Body = { messages: Array<{ role: string; content: unknown }> };
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "nativeimg4287-home-"));
	repo = mkdtempSync(join(tmpdir(), "nativeimg4287-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
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
			const body = (await req.json()) as Body & { model?: string };
			if (Array.isArray(body.messages)) bodies.push(body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model ?? "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "CLICK (1, 2)" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	bodies = [];
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	rmRetry(home);
	rmRetry(repo);
});

function chat(model: string): Promise<string> {
	const agent = new Agent({
		model,
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
	return agent.chat("Where should I click?", PNG_B64, "image/png");
}

/** Image parts the model was sent, in any shape the provider encoder uses. */
function imageParts(): number {
	const first = bodies[0];
	if (!first) return -1;
	return first.messages.reduce((n, m) => {
		if (!Array.isArray(m.content)) return n;
		return (
			n +
			m.content.filter((p: { type?: string }) => p.type === "image_url" || p.type === "image")
				.length
		);
	}, 0);
}

describe("native chat() sends the prompt image to a model that sees (#4287)", () => {
	test("vision model: one image part on the first request, no vision-unavailable note", async () => {
		await chat("llava:7b");
		expect(bodies.length).toBeGreaterThan(0);
		expect(imageParts()).toBe(1);
		expect(JSON.stringify(bodies[0].messages)).not.toContain("[Vision Unavailable]");
	}, 60_000);

	test("text-only model: no pixels sent", async () => {
		await chat("m");
		expect(bodies.length).toBeGreaterThan(0);
		expect(imageParts()).toBe(0);
	}, 60_000);
});
