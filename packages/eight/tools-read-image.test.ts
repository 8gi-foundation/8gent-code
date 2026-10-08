/**
 * #3641 / #3642: the image tools on the ToolExecutor path (text-tool and
 * local providers).
 *
 * read_image used to return width, height and 100 characters of base64; the
 * pixels never reached the model, so screen tasks could not be measured in
 * the headless harness. It now attaches the image for a model that can see,
 * and keeps the metadata-only answer for one that cannot. describe_image
 * used to call a fixed "llava"; it now takes the vision router's model and
 * says what to install when there is none.
 *
 * The image is drawn from raw pixels so the test is the same on every machine.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { IMAGE_ATTACHMENT_MARKER, splitImageAttachment } from "../ai/text-tool-loop";
import { ToolExecutor } from "./tools";
import type { VisionRouterResult } from "./vision-router";

afterAll(cleanupTempDirs);

let root: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	root = tempDir("tools-read-image-");
	// 1400x900, wider than the 1024 cap, so the attached copy is downscaled.
	const px = Buffer.alloc(1400 * 900 * 3, 40);
	await sharp(px, { raw: { width: 1400, height: 900, channels: 3 } })
		.png()
		.toFile(path.join(root, "shot.png"));
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const toolNames = (executor: ToolExecutor) =>
	executor.getToolDefinitions().map((d) => (d as { function: { name: string } }).function.name);

describe("read_image and describe_image are declared tools", () => {
	test("both appear in the executor's definitions with a path parameter", () => {
		const executor = new ToolExecutor(root);
		const defs = executor.getToolDefinitions() as Array<{
			function: {
				name: string;
				parameters: { required: string[]; properties: Record<string, unknown> };
			};
		}>;
		const readImage = defs.find((d) => d.function.name === "read_image");
		const describeImage = defs.find((d) => d.function.name === "describe_image");
		expect(readImage?.function.parameters.required).toEqual(["path"]);
		expect(describeImage?.function.parameters.required).toEqual(["path"]);
		expect(Object.keys(describeImage?.function.parameters.properties ?? {})).toEqual([
			"path",
			"prompt",
		]);
		expect(toolNames(executor)).toContain("read_pdf");
	});
});

describe("read_image (#3641)", () => {
	test("a model that can see gets the image attached, downscaled, with the metadata as text", async () => {
		const executor = new ToolExecutor(root, "primary", undefined, {
			visionCapable: async () => true,
		});
		const result = await executor.execute("read_image", { path: "shot.png" });
		expect(result).toContain(IMAGE_ATTACHMENT_MARKER);
		const { text, images } = splitImageAttachment(result);
		expect(images).toHaveLength(1);
		expect(images[0].startsWith("data:image/png;base64,")).toBe(true);
		// The attached copy fits 1024x1024 and is a real PNG.
		const attached = sharp(Buffer.from(images[0].slice("data:image/png;base64,".length), "base64"));
		const meta = await attached.metadata();
		expect(meta.format).toBe("png");
		expect(meta.width).toBe(1024);
		expect(meta.height).toBe(658);
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.width).toBe(1024);
		expect(parsed.height).toBe(658);
		expect(parsed.format).toBe("png");
		expect(String(parsed.attached)).toContain("attached");
		expect(text).not.toContain("base64Preview");
	});

	test("a model that cannot see gets the metadata only, as before", async () => {
		const executor = new ToolExecutor(root, "primary", undefined, {
			visionCapable: async () => false,
		});
		const result = await executor.execute("read_image", { path: "shot.png" });
		expect(result).not.toContain(IMAGE_ATTACHMENT_MARKER);
		const parsed = JSON.parse(result) as Record<string, unknown>;
		expect(parsed.width).toBe(1400);
		expect(parsed.height).toBe(900);
		expect(typeof parsed.base64Length).toBe("number");
	});

	test("the default executor never attaches (the MCP server and other callers see text)", async () => {
		const executor = new ToolExecutor(root);
		const result = await executor.execute("read_image", { path: "shot.png" });
		expect(result).not.toContain(IMAGE_ATTACHMENT_MARKER);
	});

	test("a missing file is an error, whatever the model can see", async () => {
		const executor = new ToolExecutor(root, "primary", undefined, {
			visionCapable: async () => true,
		});
		const result = await executor.execute("read_image", { path: "nope.png" });
		expect(result.startsWith("Error reading image:")).toBe(true);
		expect(result).not.toContain(IMAGE_ATTACHMENT_MARKER);
	});
});

describe("describe_image goes through the vision router (#3642)", () => {
	const resolved =
		(model: string | null): (() => Promise<VisionRouterResult>) =>
		async () =>
			model
				? {
						found: true,
						model: {
							provider: "ollama",
							model,
							displayName: model,
							free: true,
							ocrSpecialized: false,
						},
						allAvailable: [],
					}
				: {
						found: false,
						model: null,
						allAvailable: [],
						error:
							"No vision models found. Pull one locally: `ollama pull deepseek-ocr` (for OCR) or `ollama pull llava` (general vision), or set OPENROUTER_API_KEY for cloud vision.",
					};

	test("calls the model the router resolved, not llava", async () => {
		const generated: Array<{ model: string; prompt: string; images: string[] }> = [];
		globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
			if (!String(input).endsWith("/api/generate")) throw new Error(`unexpected ${String(input)}`);
			generated.push(JSON.parse(init?.body ?? "{}"));
			return Response.json({ response: "A grey rectangle." });
		}) as unknown as typeof fetch;
		const executor = new ToolExecutor(root, "primary", undefined, {
			resolveVisionModel: resolved("qwen2.5vl:7b"),
		});
		const result = await executor.execute("describe_image", {
			path: "shot.png",
			prompt: "What is it?",
		});
		const parsed = JSON.parse(result) as Record<string, unknown>;
		expect(parsed.model).toBe("qwen2.5vl:7b");
		expect(parsed.description).toBe("A grey rectangle.");
		expect(generated).toHaveLength(1);
		expect(generated[0].model).toBe("qwen2.5vl:7b");
		expect(generated[0].prompt).toBe("What is it?");
		expect(generated[0].images).toHaveLength(1);
	});

	test("with no local vision model, the error says what to install and nothing is called", async () => {
		globalThis.fetch = (async () => {
			throw new Error("no network expected");
		}) as unknown as typeof fetch;
		const executor = new ToolExecutor(root, "primary", undefined, {
			resolveVisionModel: resolved(null),
		});
		const result = await executor.execute("describe_image", { path: "shot.png" });
		expect(result.startsWith("Error describing image:")).toBe(true);
		expect(result).toContain("ollama pull");
	});

	test("a cloud-only router answer counts as no local model", async () => {
		globalThis.fetch = (async () => {
			throw new Error("no network expected");
		}) as unknown as typeof fetch;
		const executor = new ToolExecutor(root, "primary", undefined, {
			resolveVisionModel: async () => ({
				found: true,
				model: {
					provider: "openrouter",
					model: "x/vision:free",
					displayName: "x",
					free: true,
					ocrSpecialized: false,
				},
				allAvailable: [],
			}),
		});
		const result = await executor.execute("describe_image", { path: "shot.png" });
		expect(result.startsWith("Error describing image:")).toBe(true);
		expect(result).toContain("ollama pull");
	});
});
