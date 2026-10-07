/**
 * #3599: film_craft is reachable on the local text-tool path (ToolExecutor), writes a runnable
 * recipe with absolute paths into the working directory, and cannot write outside it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planModeRefusal } from "../permissions/permission-mode";
import { ToolExecutor } from "./tools";

const made: string[] = [];
const tmp = (p: string) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
	made.push(d);
	return d;
};
afterAll(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const slides = [
	{ title: "One", seconds: 2 },
	{ title: "Two", seconds: 2 },
];

describe("film_craft tool", () => {
	const root = tmp("tools-film-craft-");
	const executor = new ToolExecutor(root);

	test("is defined for the executor", () => {
		const names = executor
			.getToolDefinitions()
			.map((d) => (d as { function: { name: string } }).function.name);
		expect(names).toContain("film_craft");
	});

	test("plan writes video/film.sh with absolute paths; bed lands in video/", async () => {
		fs.mkdirSync(path.join(root, "audio"));
		fs.writeFileSync(path.join(root, "audio", "voice.wav"), "");
		const out = await executor.execute("film_craft", {
			action: "plan",
			preset: "lotus-night",
			slides,
			narration: "audio/voice.wav",
		});
		expect(out).toContain("2 slides, 4.00 s");
		const sh = fs.readFileSync(path.join(root, "video", "film.sh"), "utf8");
		expect(sh).toContain(path.join(root, "audio", "voice.wav"));
		expect(sh).toContain(path.join(root, "video", "film.mp4"));
		const bed = await executor.execute("film_craft", { action: "bed", seconds: 2 });
		expect(bed).toContain(path.join(root, "video", "bed.wav"));
		expect(fs.existsSync(path.join(root, "video", "bed.wav"))).toBe(true);
	});
});

describe("film_craft confinement", () => {
	const outside = tmp("film-craft-outside-");
	const listOutside = () => fs.readdirSync(outside, { recursive: true });

	test("bed through a symlinked video/ is refused", async () => {
		const root = tmp("fc-link-");
		fs.symlinkSync(outside, path.join(root, "video"));
		const r = await new ToolExecutor(root).execute("film_craft", { action: "bed", seconds: 1 });
		expect(r).toMatch(/^Error: .*link outside the working directory/);
		expect(listOutside()).toEqual([]);
	});

	test("bed out at an absolute path outside is refused", async () => {
		const root = tmp("fc-abs-");
		const r = await new ToolExecutor(root).execute("film_craft", {
			action: "bed",
			seconds: 1,
			out: path.join(outside, "bed.wav"),
		});
		expect(r).toMatch(/BLOCKED|Error/);
		expect(listOutside()).toEqual([]);
	});

	test("plan out_dir=../outside is refused", async () => {
		const root = tmp("fc-dir-");
		const r = await new ToolExecutor(root).execute("film_craft", {
			action: "plan",
			slides,
			out_dir: `../${path.basename(outside)}/plan`,
		});
		expect(r).toMatch(/BLOCKED|Error/);
		expect(listOutside()).toEqual([]);
	});

	test("plan out=../../x.mp4 is refused and no film.sh is written", async () => {
		const root = tmp("fc-out-");
		const r = await new ToolExecutor(root).execute("film_craft", {
			action: "plan",
			slides,
			out: "../../x.mp4",
		});
		expect(r).toMatch(/BLOCKED|Error/);
		expect(fs.existsSync(path.join(root, "video", "film.sh"))).toBe(false);
	});

	test("plan with a narration path outside is refused", async () => {
		const root = tmp("fc-read-");
		fs.writeFileSync(path.join(outside, "voice.wav"), "");
		fs.symlinkSync(path.join(outside, "voice.wav"), path.join(root, "voice.wav"));
		const r = await new ToolExecutor(root).execute("film_craft", {
			action: "plan",
			slides,
			narration: "voice.wav",
		});
		expect(r).toMatch(/^Error: .*link outside the working directory/);
		fs.rmSync(path.join(outside, "voice.wav"));
	});

	test("a scoped agent writes only inside its scope", async () => {
		const root = tmp("fc-scope-");
		const ex = new ToolExecutor(root, "scoped", undefined, { allowedPaths: ["clips"] });
		expect(await ex.execute("film_craft", { action: "bed", seconds: 1 })).toContain(
			"[SCOPE BLOCKED]",
		);
		expect(await ex.execute("film_craft", { action: "plan", slides, out_dir: "clips" })).toContain(
			"Wrote",
		);
		expect(await ex.execute("film_craft", { action: "list" })).toContain("lotus-night");
	});

	test("width, height and fps from the model are refused unless integers in range", async () => {
		const root = tmp("fc-dims-");
		const ex = new ToolExecutor(root);
		const marker = path.join(root, "PWNED");
		for (const bad of [{ width: `1 $(touch ${marker})` }, { height: "tall" }, { fps: "24" }])
			expect(await ex.execute("film_craft", { action: "plan", slides, ...bad })).toMatch(
				/^Error: (width|height|fps)/,
			);
		expect(fs.existsSync(path.join(root, "video", "film.sh"))).toBe(false);
	});

	test("bad seconds are refused", async () => {
		const root = tmp("fc-secs-");
		const ex = new ToolExecutor(root);
		expect(
			await ex.execute("film_craft", { action: "bed", seconds: Number.POSITIVE_INFINITY }),
		).toMatch(/^Error/);
		expect(
			await ex.execute("film_craft", {
				action: "plan",
				slides: [{ title: "x", seconds: Number.NaN }],
			}),
		).toMatch(/^Error/);
	});

	test("Plan mode allows list and mix, refuses plan and bed", async () => {
		expect(await planModeRefusal("film_craft", { action: "list" })).toBeNull();
		expect(await planModeRefusal("film_craft", { action: "mix" })).toBeNull();
		expect(await planModeRefusal("film_craft", { action: "plan" })).toContain("[PLAN MODE]");
		expect(await planModeRefusal("film_craft", { action: "bed" })).toContain("[PLAN MODE]");
	});
});
