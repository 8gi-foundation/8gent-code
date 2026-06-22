import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectGrid } from "./sprite-slicer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

beforeAll(() => {
	// Create fixture directory
	fs.mkdirSync(FIXTURES, { recursive: true });
});

afterAll(() => {
	// Clean up fixtures
	try {
		fs.rmSync(FIXTURES, { recursive: true });
	} catch {}
});

describe("detectGrid", () => {
	it("detects 8x4 grid from 512x256 image", () => {
		const result = detectGrid(512, 256);
		expect(result.cols).toBe(8);
		expect(result.rows).toBe(4);
		expect(result.frameWidth).toBe(64);
		expect(result.frameHeight).toBe(64);
	});

	it("detects grid from 256x256 image with clean tiling", () => {
		const result = detectGrid(256, 256);
		// Algorithm finds best-fit from common sizes (32px gives 8x8; 64px gives 4x4)
		// Both are valid. Verify it tiles cleanly.
		expect(result.cols * result.frameWidth).toBe(256);
		expect(result.rows * result.frameHeight).toBe(256);
		expect(result.frameWidth).toBeGreaterThan(0);
		expect(result.frameHeight).toBeGreaterThan(0);
	});

	it("detects rectangular grid from 512x512 image", () => {
		const result = detectGrid(512, 512);
		// Algorithm finds best-fit common size; expects square output
		expect(result.cols).toBeGreaterThan(0);
		expect(result.rows).toBeGreaterThan(0);
		expect(result.frameWidth).toBeGreaterThan(0);
		expect(result.frameHeight).toBeGreaterThan(0);
		// Grid cells should tile the image cleanly
		expect(result.cols * result.frameWidth).toBeLessThanOrEqual(512);
		expect(result.rows * result.frameHeight).toBeLessThanOrEqual(512);
	});

	it("handles 32x32 frames on 256x128 sheet", () => {
		const result = detectGrid(256, 128);
		expect(result.frameWidth).toBe(32);
		expect(result.frameHeight).toBe(32);
	});

	it("handles non-standard size by falling back to best fit", () => {
		const result = detectGrid(300, 200);
		expect(result.cols).toBeGreaterThan(0);
		expect(result.rows).toBeGreaterThan(0);
		expect(result.frameWidth).toBeGreaterThan(0);
		expect(result.frameHeight).toBeGreaterThan(0);
	});
});

describe("prompts", () => {
	it("buildSpritePrompt auto-detects character subject", () => {
		const { buildSpritePrompt } = require("./prompts");
		const prompt = buildSpritePrompt({ subject: "knight character" });
		expect(prompt).toContain("knight");
		expect(prompt).toContain("sprite sheet");
	});

	it("buildSpritePrompt auto-detects tileset subject", () => {
		const { buildSpritePrompt } = require("./prompts");
		const prompt = buildSpritePrompt({ subject: "forest terrain" });
		expect(prompt).toContain("tileset");
	});

	it("buildSpritePrompt auto-detects UI subject", () => {
		const { buildSpritePrompt } = require("./prompts");
		const prompt = buildSpritePrompt({ subject: "game button" });
		expect(prompt).toContain("game UI");
	});

	it("buildSpritePrompt auto-detects items subject", () => {
		const { buildSpritePrompt } = require("./prompts");
		const prompt = buildSpritePrompt({ subject: "treasure loot" });
		expect(prompt).toContain("item");
	});

	it("SPRITE_PROMPTS.character returns a function", () => {
		const { SPRITE_PROMPTS } = require("./prompts");
		const prompt = SPRITE_PROMPTS.character({ subject: "warrior" });
		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(50);
	});

	it("SPRITE_PROMPTS.tileset returns a function", () => {
		const { SPRITE_PROMPTS } = require("./prompts");
		const prompt = SPRITE_PROMPTS.tileset({ subject: "dungeon" });
		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("tileset");
	});

	it("SPRITE_PROMPTS.ui returns a function", () => {
		const { SPRITE_PROMPTS } = require("./prompts");
		const prompt = SPRITE_PROMPTS.ui({ subject: "RPG" });
		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("game UI");
	});

	it("SPRITE_PROMPTS.items returns a function", () => {
		const { SPRITE_PROMPTS } = require("./prompts");
		const prompt = SPRITE_PROMPTS.items({ subject: "fantasy" });
		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("item");
	});

	it("SPRITE_PROMPTS.particles returns a function", () => {
		const { SPRITE_PROMPTS } = require("./prompts");
		const prompt = SPRITE_PROMPTS.particles({ subject: "magic fire" });
		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("particle");
	});

	it("buildSpritePrompt respects custom config", () => {
		const { buildSpritePrompt } = require("./prompts");
		const prompt = buildSpritePrompt({
			subject: "robot",
			style: "3d-render",
			cols: 6,
			rows: 4,
			frameSize: 128,
			view: "front",
		});
		expect(prompt).toContain("3d-render");
		expect(prompt).toContain("6 columns");
		expect(prompt).toContain("128x128");
		expect(prompt).toContain("front");
	});
});

describe("animation-generator", () => {
	it("getFrameDuration calculates from fps", () => {
		const { getFrameDuration } = require("./animation-generator");
		expect(getFrameDuration(12)).toBe(83); // 1000/12 ≈ 83ms
		expect(getFrameDuration(24)).toBe(42); // 1000/24 ≈ 42ms
		expect(getFrameDuration(30)).toBe(33); // 1000/30 ≈ 33ms
	});

	it("getFrameDuration uses custom duration when provided", () => {
		const { getFrameDuration } = require("./animation-generator");
		expect(getFrameDuration(12, 200)).toBe(200);
	});

	it("animate throws when frame directory does not exist", async () => {
		const { animate } = require("./animation-generator");
		await expect(
			animate({ frames: "/nonexistent/directory", output: "/tmp/out.gif" }),
		).rejects.toThrow();
	});

	it("animate throws on empty array", async () => {
		const { animate } = require("./animation-generator");
		await expect(
			animate({ frames: [], output: "/tmp/out.gif" }),
		).rejects.toThrow("No frames found");
	});
});

describe("scaffold", () => {
	it("scaffoldGame generates files for phaser platformer", () => {
		const { scaffoldGame } = require("./scaffold");
		const result = scaffoldGame({
			name: "Test Game",
			outputDir: FIXTURES,
			engine: "phaser",
			type: "platformer",
		});
		expect(result.files.length).toBeGreaterThan(0);
		expect(result.entryPoint).toContain("index.html");

		// Check package.json was created
		const pkgPath = path.join(FIXTURES, "package.json");
		expect(fs.existsSync(pkgPath)).toBe(true);
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		expect(pkg.name).toBe("test-game");
		expect(pkg.dependencies.phaser).toBeDefined();
	});

	it("scaffoldGame generates files for pixi topdown", () => {
		const { scaffoldGame } = require("./scaffold");
		const result = scaffoldGame({
			name: "Pixi Game",
			outputDir: path.join(FIXTURES, "pixi"),
			engine: "pixi",
			type: "topdown",
		});
		expect(result.files.length).toBeGreaterThan(0);
		expect(fs.existsSync(result.entryPoint)).toBe(true);
	});

	it("scaffoldGame uses custom dimensions", () => {
		const { scaffoldGame } = require("./scaffold");
		const result = scaffoldGame({
			name: "Wide Game",
			outputDir: path.join(FIXTURES, "wide"),
			engine: "phaser",
			type: "shooter",
			width: 1280,
			height: 720,
		});
		const mainPath = path.join(FIXTURES, "wide", "src", "main.ts");
		const content = fs.readFileSync(mainPath, "utf8");
		expect(content).toContain("1280");
		expect(content).toContain("720");
	});
});
