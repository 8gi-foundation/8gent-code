import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { rmRetry } from "../../tests/rm-retry";
import { screenLocate, screenLocateOffered } from "../eyes/ground/screen-locate";
import type { BBox, GroundBackend } from "../eyes/ground/types";
import { ToolExecutor } from "./tools";

let dir: string;
let png: string;

/** A backend that always answers with one box in the prepared image's space. */
const fake = (box: BBox | null): GroundBackend => ({
	id: "fake",
	model: "fake",
	endpoint: "http://127.0.0.1:1",
	locate: async () => (box ? { bbox: box, raw: "" } : { error: "no box in model reply" }),
});

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "screen-locate-"));
	png = join(dir, "shot.png");
	// 2560x1600 screenshot of a 1280x800 viewport (2x device pixel ratio).
	await sharp({ create: { width: 2560, height: 1600, channels: 3, background: "#fff" } })
		.png()
		.toFile(png);
});
afterAll(() => rmRetry(dir));

describe("screen_locate", () => {
	test("scales image pixels to viewport CSS pixels", async () => {
		const prep = await sharp(png).metadata();
		expect(prep.width).toBe(2560);
		// Whatever size the grounder resizes to, ask for the middle: box [40%,40%,60%,60%].
		const { prepareImage } = await import("../eyes/ground/image");
		const p = await prepareImage(png);
		const box: BBox = [p.width * 0.4, p.height * 0.4, p.width * 0.6, p.height * 0.6];
		const out = JSON.parse(
			await screenLocate(
				{ image: png, target: "the button", viewport: "1280x800" },
				{ backend: fake(box) },
			),
		);
		expect(out.x).toBeGreaterThan(1200);
		expect(out.x).toBeLessThan(1360);
		expect(out.cssX).toBeGreaterThan(600);
		expect(out.cssX).toBeLessThan(680);
		expect(out.cssY).toBeGreaterThan(380);
		expect(out.cssY).toBeLessThan(420);
		expect(out.bbox).toHaveLength(4);
	});

	test("without viewport returns image space only", async () => {
		const out = JSON.parse(
			await screenLocate({ image: png, target: "x" }, { backend: fake([100, 100, 200, 200]) }),
		);
		expect(out.cssX).toBeUndefined();
		expect(out.space).toBe("image");
	});

	test("not found is said plainly", async () => {
		const out = await screenLocate({ image: png, target: "unicorn" }, { backend: fake(null) });
		expect(out).toStartWith("Not found:");
	});

	test("low confidence is not found", async () => {
		// Box covering the whole frame scores below 0.5 (not a control).
		const { prepareImage } = await import("../eyes/ground/image");
		const p = await prepareImage(png);
		const out = await screenLocate(
			{ image: png, target: "x" },
			{ backend: fake([0, 0, p.width + 400, p.height + 400]) },
		);
		expect(out).toStartWith("Not found:");
	});

	test("bad viewport is an error", async () => {
		expect(
			await screenLocate({ image: png, target: "x", viewport: "wide" }, { backend: fake(null) }),
		).toStartWith("Error:");
	});
});

describe("screen_locate tool wiring", () => {
	test("is declared and in the local tool list", () => {
		const defs = new ToolExecutor(dir).getToolDefinitions() as { function: { name: string } }[];
		expect(defs.map((d) => d.function.name)).toContain("screen_locate");
	});

	test("offered to a local session only with a screenshot source", () => {
		expect(screenLocateOffered({ browserTools: 0, desktopTools: false, env: {} })).toBe(false);
		expect(screenLocateOffered({ browserTools: 4, desktopTools: false, env: {} })).toBe(true);
		expect(screenLocateOffered({ browserTools: 0, desktopTools: true, env: {} })).toBe(true);
		expect(
			screenLocateOffered({
				browserTools: 0,
				desktopTools: false,
				env: { EIGHT_SCREEN_LOCATE: "1" },
			}),
		).toBe(true);
		// Whitespace and trailing commas are the formatter's, not the wiring's.
		const src = require("node:fs")
			.readFileSync(join(import.meta.dir, "agent.ts"), "utf8")
			.replace(/\s+/g, "")
			.replace(/,\}/g, "}");
		expect(src).toContain(
			"screenLocateOffered({browserTools:localBrowserTools().length,desktopTools:cuaConfigured})",
		);
	});

	test("path guard refuses credential paths", async () => {
		const ex = new ToolExecutor(dir);
		for (const image of ["~/.ssh/id_rsa", "/etc/passwd", "../../../.env"]) {
			// Same refusal read_file gives: the guard throws before any model call.
			// A boundary block comes back as the terminal text (#4715); the credential guard throws.
			const out = await ex
				.execute("screen_locate", { image, target: "x" })
				.catch((e: Error) => e.message);
			expect(out).toMatch(/blocked|outside|cannot be read/i);
		}
	});
});
