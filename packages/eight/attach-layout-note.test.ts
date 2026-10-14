/**
 * #3823: an image the TUI attaches to a turn carries the measured layout too,
 * once. Drives chat() against a fake OpenAI-compatible endpoint with a
 * vision-capable model (modelSees stubbed) and asserts on the request bodies.
 * $HOME is faked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { rmRetry } from "../../tests/rm-retry";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const NEEDLE = "Measured layout of the full-size image";

type Body = { messages: Array<{ role: string; content: unknown }> };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let readImageFirst = false;

function reply(content: string) {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

async function png(boxes: boolean): Promise<Buffer> {
	const W = 400;
	const H = 200;
	const px = Buffer.alloc(W * H * 3, 255);
	if (boxes)
		for (let y = 20; y < 60; y++) for (let x = 50; x < 350; x++) px.set([0, 0, 0], (y * W + x) * 3);
	return sharp(px, { raw: { width: W, height: H, channels: 3 } })
		.png()
		.toBuffer();
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "attach3823-home-"));
	repo = mkdtempSync(join(tmpdir(), "attach3823-repo-"));
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
			bodies.push((await req.json()) as Body);
			if (readImageFirst && bodies.length === 1) {
				const call = { name: "read_image", arguments: { path: join(repo, "mock.png") } };
				return reply(["```tool_call", JSON.stringify(call), "```"].join("\n"));
			}
			return reply("DONE.");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	bodies = [];
	readImageFirst = false;
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

function build(): AgentT {
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
	(agent as unknown as { modelSees: () => Promise<boolean> }).modelSees = () =>
		Promise.resolve(true);
	return agent;
}

/** How many times the last request of the turn carries the layout block. */
const copies = () =>
	(bodies[bodies.length - 1]?.messages ?? []).filter((m) =>
		JSON.stringify(m.content).includes(NEEDLE),
	).length;

describe("attached image layout note (#3823)", () => {
	test("pushed when the image is attached and the measurement is non-empty", async () => {
		const img = await png(true);
		await build().chat("Turn this mock-up into a page.", img.toString("base64"), "image/png");
		expect(copies()).toBe(1);
	}, 60_000);

	test("not pushed when the measurement is empty (a blank image)", async () => {
		const img = await png(false);
		await build().chat("Turn this mock-up into a page.", img.toString("base64"), "image/png");
		expect(bodies.length).toBeGreaterThan(0);
		expect(copies()).toBe(0);
	}, 60_000);

	test("not duplicated when read_image follows on the same image", async () => {
		const img = await png(true);
		writeFileSync(join(repo, "mock.png"), img);
		readImageFirst = true;
		await build().chat("Turn mock.png into a page.", img.toString("base64"), "image/png");
		expect(bodies.length).toBeGreaterThan(1);
		expect(copies()).toBe(1);
	}, 60_000);
});

describe("downscale note on an attached image (#4293)", () => {
	const asked = () => JSON.stringify(bodies[bodies.length - 1]?.messages ?? []);

	test("a no-band image still gets the note when its copy is smaller than the original", async () => {
		const copy = await sharp(await png(false))
			.resize(100, 50)
			.png()
			.toBuffer();
		const meta = await sharp(copy).metadata();
		await build().chat("Click the button.", copy.toString("base64"), "image/png", {
			width: 400,
			height: 200,
		});
		expect(meta.width).toBe(100);
		expect(asked()).toContain("downscaled copy (100x50 px) of the original (400x200 px)");
		expect(asked()).toContain("by 4");
	}, 60_000);

	test("no note when the copy is the original size", async () => {
		const img = await png(false);
		await build().chat("Click the button.", img.toString("base64"), "image/png", {
			width: 400,
			height: 200,
		});
		expect(asked()).not.toContain("downscaled copy");
	}, 60_000);

	test("read_image on a large file states the original size and factor", async () => {
		const big = await sharp({
			create: { width: 2048, height: 512, channels: 3, background: "#ffffff" },
		})
			.png()
			.toBuffer();
		writeFileSync(join(repo, "mock.png"), big);
		readImageFirst = true;
		await build().chat("Look at mock.png.");
		expect(bodies.length).toBeGreaterThan(1);
		expect(asked()).toContain("downscaled copy (1024x256 px) of the original (2048x512 px)");
		expect(asked()).toContain("by 2");
	}, 60_000);
});
