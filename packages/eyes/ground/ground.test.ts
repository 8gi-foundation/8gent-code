import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { parseBox, toImageSpace } from "./backends/qwen-vl.js";
import { prepareImage, scaleBack, smartResize } from "./image.js";
import { backendFromEnv, ground, shapeConfidence } from "./index.js";
import { NonLoopbackEndpointError, assertLoopback } from "./loopback.js";
import type { GroundBackend, PreparedImage } from "./types.js";

describe("assertLoopback", () => {
	test.each(["http://127.0.0.1:11434", "http://localhost:1234", "http://[::1]:11434"])(
		"allows %s",
		(u) => {
			expect(() => assertLoopback(u)).not.toThrow();
		},
	);
	test.each([
		"http://10.0.0.5:11434",
		"https://api.openai.com",
		"http://127.0.0.1.evil.com:11434",
		"http://user:pw@127.0.0.1:11434",
		"file:///etc/passwd",
		"not a url",
		"http://0.0.0.0:11434",
	])("refuses %s", (u) => {
		expect(() => assertLoopback(u)).toThrow(NonLoopbackEndpointError);
	});
	test("backendFromEnv fails closed on a remote endpoint", () => {
		expect(() => backendFromEnv({ EIGHT_GROUND_ENDPOINT: "http://192.168.1.20:11434" })).toThrow(
			NonLoopbackEndpointError,
		);
	});
	test("ground() refuses a backend whose endpoint is remote, without calling it", async () => {
		let called = false;
		const remote: GroundBackend = {
			id: "x",
			model: "x",
			endpoint: "http://203.0.113.9:11434",
			async locate() {
				called = true;
				return { bbox: [0, 0, 1, 1], raw: "" };
			},
		};
		const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
			.png()
			.toBuffer();
		const out = await ground({ image: png, instruction: "a button" }, { backend: remote });
		expect(out.ok).toBe(false);
		expect(called).toBe(false);
	});
});

describe("parseBox", () => {
	test("bbox_2d in a fenced json block", () => {
		expect(
			parseBox('```json\n[{"bbox_2d": [1098, 41, 1259, 90], "label": "Sign in"}]\n```'),
		).toEqual([1098, 41, 1259, 90]);
	});
	test("reversed corners are ordered", () => {
		expect(parseBox('{"bbox_2d":[50,60,10,20]}')).toEqual([10, 20, 50, 60]);
	});
	test("point_2d becomes a small box", () => {
		expect(parseBox('[{"point_2d": [100, 200]}]')).toEqual([95, 195, 105, 205]);
	});
	test("not visible", () => {
		expect(parseBox("[]")).toBeNull();
		expect(parseBox("I cannot find it.")).toBeNull();
	});
});

describe("image sizing", () => {
	test("smartResize output is a fixed point (Ollama will not resize again)", () => {
		for (const [w, h] of [
			[1440, 900],
			[2880, 1800],
			[800, 600],
			[1920, 1200],
		]) {
			const r = smartResize(w, h);
			expect(r.width % 28).toBe(0);
			expect(r.height % 28).toBe(0);
			expect(r.width * r.height).toBeLessThanOrEqual(1280 * 28 * 28);
			expect(smartResize(r.width, r.height)).toEqual(r);
		}
	});
	test("scaleBack maps prepared pixels to original pixels", async () => {
		const png = await sharp({
			create: { width: 2880, height: 1800, channels: 3, background: "#fff" },
		})
			.png()
			.toBuffer();
		const img = await prepareImage(png);
		expect(img.origWidth).toBe(2880);
		const back = scaleBack([img.width / 2, img.height / 2, img.width, img.height], img);
		expect(back).toEqual([1440, 900, 2880, 1800]);
	});
	test("norm1000 converts to prepared pixels", () => {
		const img = { width: 1000, height: 500 } as PreparedImage;
		expect(toImageSpace([100, 100, 200, 200], "norm1000", img)).toEqual([100, 50, 200, 100]);
	});
});

describe("shapeConfidence", () => {
	test("a button-sized box inside the frame scores 1", () => {
		expect(shapeConfidence([10, 10, 110, 50], 1440, 900, [10, 10, 110, 50], 1440, 900)).toBe(1);
	});
	test("a whole-page box is penalised", () => {
		expect(
			shapeConfidence([0, 0, 1440, 900], 1440, 900, [0, 0, 1440, 900], 1440, 900),
		).toBeLessThan(0.7);
	});
	test("a box outside the model image is penalised", () => {
		expect(shapeConfidence([10, 10, 50, 50], 100, 100, [10, 10, 500, 500], 100, 100)).toBe(0.7);
	});
});
