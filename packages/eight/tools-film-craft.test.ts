/**
 * #3599: film_craft is reachable on the local text-tool path (ToolExecutor) and writes a runnable recipe
 * with absolute paths into the working directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "./tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-film-craft-"));
const executor = new ToolExecutor(root);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("film_craft tool", () => {
	test("is defined for the executor", () => {
		const names = executor
			.getToolDefinitions()
			.map((d) => (d as { function: { name: string } }).function.name);
		expect(names).toContain("film_craft");
	});

	test("plan writes video/film.sh with absolute paths; bed lands in video/", async () => {
		const slides = [
			{ title: "One", seconds: 2 },
			{ title: "Two", seconds: 2 },
		];
		const out = await executor.execute("film_craft", {
			action: "plan",
			preset: "lotus-night",
			slides,
			narration: "video/voice.wav",
		});
		expect(out).toContain("2 slides, 4.00 s");
		const sh = fs.readFileSync(path.join(root, "video", "film.sh"), "utf8");
		expect(sh).toContain(path.join(root, "video", "voice.wav"));
		expect(sh).toContain(path.join(root, "video", "film.mp4"));
		const bed = await executor.execute("film_craft", { action: "bed", seconds: 2 });
		expect(bed).toContain(path.join(root, "video", "bed.wav"));
		expect(fs.existsSync(path.join(root, "video", "bed.wav"))).toBe(true);
	});
});
