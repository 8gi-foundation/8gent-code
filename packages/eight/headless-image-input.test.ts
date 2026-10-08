/**
 * #3641: a headless `8gent run` on a vision-capable local model can see an
 * image, whether the task names a file (read_image) or the caller attaches
 * one (--image). The SIGI v1.0 baseline found neither path existed: the
 * image tools were never declared on the text-tool path, read_image returned
 * metadata only, and `run` had no way to attach an image, so every
 * screen-understanding task fell back to shell commands.
 *
 * Like harness-notes-reach-model.test.ts this drives the shipping chat() and
 * run paths against a fake Ollama and asserts on the request bodies the model
 * receives. The fake answers /api/show with "vision" for the model `see` and
 * without it for `blind`. $HOME is faked so the operator's memories, sessions
 * and config stay out of the test.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let runRunCommand: typeof import("./run").runRunCommand;
let parseRunArgs: typeof import("./run").parseRunArgs;

type Part = { type: string; text?: string; image_url?: { url: string } };
type Msg = { role: string; content: string | Part[] };
type Body = { model: string; messages: Msg[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];
const shows: string[] = [];

const TOOL_CALL_REPLY = [
	"Let me look at the screenshot.",
	"```tool_call",
	'{"name": "read_image", "arguments": {"path": "shot.png"}}',
	"```",
].join("\n");
const ANSWER = "DONE: Click the Save button at the top right.";

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "img3641-home-"));
	repo = mkdtempSync(join(tmpdir(), "img3641-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	// A real PNG, drawn from raw pixels so it is the same on every machine.
	const px = Buffer.alloc(64 * 48 * 3, 40);
	await sharp(px, { raw: { width: 64, height: 48, channels: 3 } })
		.png()
		.toFile(join(repo, "shot.png"));
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/api/tags")
				return Response.json({ models: [{ name: "see" }, { name: "blind" }] });
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			if (pathname === "/api/show") {
				const { model } = (await req.json()) as { model: string };
				shows.push(model);
				return Response.json({
					capabilities:
						model === "see" ? ["completion", "vision", "tools"] : ["completion", "tools"],
				});
			}
			const body = (await req.json()) as Body;
			bodies.push(body);
			// The first request of a turn asks for the image unless the image is
			// already on the prompt; every later one answers.
			const hasImage = body.messages.some((m) => Array.isArray(m.content));
			const toolResult = body.messages.some(
				(m) => typeof m.content === "string" && m.content.includes("Tool read_image returned:"),
			);
			const answered = body.messages.some((m) => m.role === "assistant");
			const content = hasImage || toolResult || answered ? ANSWER : TOOL_CALL_REPLY;
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	({ Agent } = await import("./agent"));
	({ runRunCommand, parseRunArgs } = await import("./run"));
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function build(model: string, events?: Record<string, unknown>): AgentT {
	return new Agent({
		model,
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		keepAnswerFirst: true,
		events,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** The image_url parts anywhere in a request body. */
function imageParts(body: Body): Part[] {
	return body.messages.flatMap((m) =>
		Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : [],
	);
}

const PROMPT =
	"The screenshot of the editor is the file shot.png in this folder. Read the image and tell me which button to click to save the document.";

describe("read_image on a headless text-tool turn (#3641)", () => {
	test("a seeing model gets the pixels on the message after the tool call", async () => {
		const start = bodies.length;
		const toolsStarted: string[] = [];
		const agent = build("see", {
			onToolStart: (e: { toolName: string }) => toolsStarted.push(e.toolName),
		});
		const reply = await agent.chat(PROMPT);

		expect(toolsStarted).toContain("read_image");
		expect(reply).toContain("Click the Save button at the top right.");
		expect(shows).toContain("see");

		const turn = bodies.slice(start);
		// The first request declared read_image to the model and carried no image.
		expect(JSON.stringify(turn[0].messages)).toContain("read_image");
		expect(imageParts(turn[0])).toHaveLength(0);
		// The request after the tool ran carries the image on the tool-result
		// message, as an image_url data URL next to the metadata text.
		const after = turn[1];
		const parts = imageParts(after);
		expect(parts).toHaveLength(1);
		expect(parts[0].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
		const withImage = after.messages.find((m) => Array.isArray(m.content)) as { content: Part[] };
		const text = withImage.content.find((p) => p.type === "text")?.text ?? "";
		expect(text).toContain("Tool read_image returned:");
		expect(text).toContain('"width": 64');
		expect(text).not.toContain("[image-attachment]");
		// A tool_use/tool_result event pair fired for the call.
		await agent.cleanup();
	}, 60_000);

	test("a model that cannot see gets metadata, and no request carries an image", async () => {
		const start = bodies.length;
		const toolsStarted: string[] = [];
		const agent = build("blind", {
			onToolStart: (e: { toolName: string }) => toolsStarted.push(e.toolName),
		});
		await agent.chat(PROMPT);
		expect(toolsStarted).toContain("read_image");
		const turn = bodies.slice(start);
		expect(turn.length).toBeGreaterThanOrEqual(2);
		for (const body of turn) expect(imageParts(body)).toHaveLength(0);
		const followUp = JSON.stringify(turn[1].messages);
		expect(followUp).toContain("Tool read_image returned:");
		expect(followUp).toContain("base64Length");
		await agent.cleanup();
	}, 60_000);
});

describe("`8gent run --image` (#3641)", () => {
	test("parseRunArgs reads --image in both spellings", () => {
		expect(parseRunArgs(["--image", "shot.png", "where", "is", "save"]).image).toBe("shot.png");
		expect(parseRunArgs(["--image=a/b.jpg", "x"]).image).toBe("a/b.jpg");
		expect(parseRunArgs(["--image=a/b.jpg", "x"]).prompt).toBe("x");
		expect(parseRunArgs(["x"]).image).toBeUndefined();
	});

	test("the attached image reaches a seeing model on the first request", async () => {
		const start = bodies.length;
		const out: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
		let code: number;
		try {
			code = await runRunCommand([
				"--provider",
				"ollama",
				"--model",
				"see",
				"--cwd",
				repo,
				"--image",
				"shot.png",
				"--output-format",
				"stream-json",
				"Here is a screenshot of the editor. Which button do I click to save the document? Answer in one line.",
			]);
		} finally {
			write.mockRestore();
		}
		expect(code).toBe(0);
		const turn = bodies.slice(start);
		expect(turn.length).toBeGreaterThanOrEqual(1);
		const parts = imageParts(turn[0]);
		expect(parts).toHaveLength(1);
		expect(parts[0].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
		// The prompt text travels next to the image.
		const withImage = turn[0].messages.find((m) => Array.isArray(m.content)) as { content: Part[] };
		expect(withImage.content.find((p) => p.type === "text")?.text).toContain(
			"Which button do I click",
		);
		// The result event carries the answer.
		const events = out
			.join("")
			.split("\n")
			.filter(Boolean)
			.map(
				(l) =>
					JSON.parse(l) as { type: string; subtype?: string; final_text?: string; model?: string },
			);
		expect(events[0]).toMatchObject({ type: "session_start", model: "see" });
		const result = events.find((e) => e.type === "result");
		expect(result?.subtype).toBe("ok");
		expect(result?.final_text).toContain("Click the Save button at the top right.");
	}, 60_000);

	test("a missing --image file is a usage error before any model request", async () => {
		const start = bodies.length;
		const out: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
		let code: number;
		try {
			code = await runRunCommand([
				"--provider",
				"ollama",
				"--model",
				"see",
				"--cwd",
				repo,
				"--image",
				"missing.png",
				"--output-format",
				"stream-json",
				"Which button do I click?",
			]);
		} finally {
			write.mockRestore();
		}
		expect(code).toBe(1);
		expect(bodies.length).toBe(start);
		const events = out
			.join("")
			.split("\n")
			.filter(Boolean)
			.map(
				(l) =>
					JSON.parse(l) as { type: string; subtype?: string; message?: string; error?: string },
			);
		const err = events.find((e) => e.type === "error");
		expect(err?.subtype).toBe("usage");
		expect(err?.message).toContain("missing.png");
		expect(events.at(-1)).toMatchObject({ type: "result", subtype: "error" });
	});

	test("an unsupported extension is a usage error too", async () => {
		const start = bodies.length;
		const err: string[] = [];
		const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			err.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		let code: number;
		try {
			code = await runRunCommand([
				"--provider",
				"ollama",
				"--model",
				"see",
				"--image",
				"notes.txt",
				"look",
			]);
		} finally {
			write.mockRestore();
		}
		expect(code).toBe(1);
		expect(bodies.length).toBe(start);
		expect(err.join("")).toContain("png, jpg, gif or webp");
	});
});
