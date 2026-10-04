import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	breakdown,
	findMediaTool,
	lookOf,
	refBreakdownEnabled,
	shotTable,
	writeBreakdown,
} from "./reference-breakdown";

const dir = mkdtempSync(join(tmpdir(), "ref-breakdown-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ON = { ...process.env, EIGHT_REF_BREAKDOWN: "1" };
const ffmpeg = findMediaTool("ffmpeg");
const ffprobe = findMediaTool("ffprobe");

function rgbOf(hex: string): number[] {
	return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}
function near(hex: string, want: number[]): boolean {
	return rgbOf(hex).every((v, i) => Math.abs(v - want[i]) <= 32);
}

describe("flag", () => {
	test("off by default and for anything but 1", () => {
		expect(refBreakdownEnabled({})).toBe(false);
		expect(refBreakdownEnabled({ EIGHT_REF_BREAKDOWN: "0" })).toBe(false);
		expect(refBreakdownEnabled({ EIGHT_REF_BREAKDOWN: "true" })).toBe(false);
		expect(refBreakdownEnabled({ EIGHT_REF_BREAKDOWN: "1" })).toBe(true);
	});
	test("breakdown refuses when the flag is off, before touching the file", async () => {
		await expect(breakdown(join(dir, "anything.mp4"), {})).rejects.toThrow("EIGHT_REF_BREAKDOWN=1");
	});
});

describe("input validation", () => {
	test("a missing file is a clear error", async () => {
		await expect(breakdown(join(dir, "missing.mp4"), ON)).rejects.toThrow("No such video file");
	});
	test("a URL is refused", async () => {
		await expect(breakdown("https://example.com/clip.mp4", ON)).rejects.toThrow("Local files only");
	});
	test("a directory is refused", async () => {
		await expect(breakdown(dir, ON)).rejects.toThrow("No such video file");
	});
	test.skipIf(!ffmpeg || !ffprobe)("a non-video file is a clear error", async () => {
		const txt = join(dir, "notes.txt");
		writeFileSync(txt, "not a video\n");
		await expect(breakdown(txt, ON)).rejects.toThrow(/Not a (readable )?video file/);
	});
});

describe("lookOf", () => {
	test("solid colour gives one colour, zero contrast", () => {
		const px = new Uint8Array(30).fill(0);
		for (let i = 0; i < 30; i += 3) px[i] = 255;
		const look = lookOf(px);
		expect(look.colours).toEqual([{ hex: "#ff0000", share: 1 }]);
		expect(look.contrast).toBe(0);
		expect(look.darkRatio).toBe(0);
	});
	test("black is all dark", () => {
		expect(lookOf(new Uint8Array(12)).darkRatio).toBe(1);
	});
});

describe.skipIf(!ffmpeg || !ffprobe)("breakdown on a synthetic 3-shot clip", () => {
	const clip = join(dir, "three.mp4");
	const want = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
	];

	test("3 shots of about 2 s, right dominant colour each, report written", async () => {
		const inputs = ["0xff0000", "0x00ff00", "0x0000ff"].flatMap((c) => [
			"-f",
			"lavfi",
			"-i",
			`color=c=${c}:s=320x180:d=2:r=25`,
		]);
		execFileSync(ffmpeg as string, [
			"-v",
			"error",
			"-y",
			...inputs,
			"-filter_complex",
			"concat=n=3:v=1:a=0",
			"-c:v",
			"mpeg4",
			"-q:v",
			"2",
			"-pix_fmt",
			"yuv420p",
			clip,
		]);

		const b = await breakdown(clip, ON);
		expect(b.shots.length).toBe(3);
		for (const [i, s] of b.shots.entries()) {
			expect(Math.abs(s.len - 2)).toBeLessThan(0.15);
			expect(s.colours.length).toBeGreaterThan(0);
			expect(s.colours[0].share).toBeGreaterThan(0.9);
			expect(near(s.colours[0].hex, want[i])).toBe(true);
		}
		expect(Math.abs(b.avgShotLen - 2)).toBeLessThan(0.1);
		expect(Math.abs(b.cutsPerMinute - 20)).toBeLessThan(2); // 2 cuts in 6 s;

		const out = writeBreakdown(b, join(dir, "analysis"));
		expect(JSON.parse(readFileSync(out.report, "utf-8")).shots.length).toBe(3);
		const lines = readFileSync(out.table, "utf-8").trim().split("\n");
		expect(lines.length).toBe(4);
		expect(shotTable(b)).toContain("shots 3");
	}, 60_000);
});

describe("tool lookup", () => {
	test("a missing EIGHT_FFMPEG_PATH returns null instead of falling back", () => {
		expect(
			findMediaTool("ffmpeg", {
				EIGHT_FFMPEG_PATH: join(dir, "no-such-ffmpeg"),
				PATH: "/opt/homebrew/bin:/usr/bin",
			}),
		).toBeNull();
	});
});

describe.skipIf(!ffmpeg || !ffprobe)("bounds and local-file handling", () => {
	const strobe = join(dir, "strobe.mp4");
	const one = join(dir, "one.mp4");
	const make = () => {
		if (existsSync(strobe)) return;
		// Black and white swap every 0.2 s for 2 s: 9 cuts, 10 shots.
		execFileSync(ffmpeg as string, [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=64x36:d=2:r=10",
			"-vf",
			"geq=lum='if(mod(floor(T*5),2),235,16)':cb=128:cr=128",
			"-c:v",
			"mpeg4",
			"-q:v",
			"2",
			"-pix_fmt",
			"yuv420p",
			strobe,
		]);
		execFileSync(ffmpeg as string, [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x00ff00:s=64x36:d=1:r=10",
			"-c:v",
			"mpeg4",
			"-pix_fmt",
			"yuv420p",
			one,
		]);
	};

	test("the shot cap holds, the tail merges into the last shot, and the report says truncated", async () => {
		make();
		const b = await breakdown(strobe, ON, { maxShots: 3 });
		expect(b.detectedShots).toBeGreaterThan(3);
		expect(b.shots.length).toBe(3);
		expect(b.truncated).toBe(true);
		expect(b.shots[2].end).toBe(b.duration);
		const out = writeBreakdown(b, join(dir, "strobe-out"));
		expect(JSON.parse(readFileSync(out.report, "utf-8")).truncated).toBe(true);
		expect(readFileSync(out.table, "utf-8")).toContain("truncated");
	}, 60_000);

	test("the spawn budget stops sampling and marks the rest unsampled", async () => {
		make();
		// probe + scene pass + 3 frames for one shot = 5 spawns.
		const b = await breakdown(strobe, ON, { maxSpawns: 5 });
		expect(b.truncated).toBe(true);
		expect(b.shots[0].brightness).not.toBeNull();
		expect(b.shots[1].brightness).toBeNull();
		expect(b.shots[1].colours).toEqual([]);
		expect(shotTable(b)).toContain("not sampled");
	}, 60_000);

	test("a run past its time budget fails clearly", async () => {
		make();
		await expect(breakdown(strobe, ON, { budgetMs: 1 })).rejects.toThrow("time budget");
	});

	test("an untruncated run says truncated: false", async () => {
		make();
		const b = await breakdown(one, ON);
		expect(b.truncated).toBe(false);
		expect(b.shots.length).toBe(1);
	}, 60_000);

	test("a local playlist pointing at http is refused without network", async () => {
		const m3u8 = join(dir, "remote.m3u8");
		writeFileSync(
			m3u8,
			"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/seg.ts\n#EXT-X-ENDLIST\n",
		);
		await expect(breakdown(m3u8, ON)).rejects.toThrow(/Not a (readable )?video file/);
	}, 30_000);

	test("dash-prefixed and subfile-style names are read as plain local files", async () => {
		make();
		const cwd = process.cwd();
		for (const n of ["-dash.mp4", "subfile,,start,0,end,0,,.mp4"]) {
			copyFileSync(one, join(dir, n));
			process.chdir(dir);
			try {
				const b = await breakdown(n, ON);
				expect(b.file).toBe(join(realpathSync(dir), n));
				expect(b.shots.length).toBe(1);
			} finally {
				process.chdir(cwd);
			}
		}
	}, 60_000);
});

describe.skipIf(!ffmpeg || !ffprobe)("argv", () => {
	test("every ffmpeg and ffprobe call pins the file protocol before its input", async () => {
		const clip = join(dir, "argv.mp4");
		execFileSync(ffmpeg as string, [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=64x36:d=1:r=10",
			"-c:v",
			"mpeg4",
			"-pix_fmt",
			"yuv420p",
			clip,
		]);
		const calls: string[][] = [];
		await breakdown(clip, ON, { onSpawn: (_c, a) => calls.push(a) });
		expect(calls.length).toBe(5);
		for (const a of calls) {
			const at = a.indexOf("-protocol_whitelist");
			expect(at).toBeGreaterThan(-1);
			expect(a[at + 1]).toBe("file");
			expect(at).toBeLessThan(a.indexOf(clip));
			expect(a.filter((x) => x === clip).length).toBe(1);
		}
	}, 60_000);
});
