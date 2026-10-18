/** System One passes a plain ffmpeg build of a NEW media file from workspace files; everything else reaches the judge. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ffmpegInProject } from "./s1-ffmpeg-in-project";

afterAll(cleanupTempDirs);

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(16),
]);
const WAV = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.alloc(4),
	Buffer.from("WAVEfmt "),
	Buffer.alloc(16),
]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(16)]);

let w: string;
beforeAll(() => {
	w = tempDir("ffmpeg-lane-");
	mkdirSync(join(w, "video"));
	for (const f of ["video/slide1.png", "slide1.png"]) writeFileSync(join(w, f), PNG);
	for (const f of ["video/n1.wav", "n1.wav"]) writeFileSync(join(w, f), WAV);
	writeFileSync(join(w, "video/seg1.mp4"), MP4);
	writeFileSync(join(w, "video/seg2.mp4"), MP4);
	writeFileSync(join(w, "video/list.txt"), "file 'seg1.mp4'\nfile 'seg2.mp4'\n");
	writeFileSync(join(w, "video/evil.txt"), "file '/etc/passwd'\n");
	writeFileSync(join(w, "video/up.txt"), "file '../../outside.mp4'\n");
	// sub/etc/x.wav is a valid workspace file; the real /etc/x.wav is not the workspace's (8SO).
	mkdirSync(join(w, "sub/etc"), { recursive: true });
	writeFileSync(join(w, "sub/etc/x.wav"), WAV);
	writeFileSync(join(w, "sub/abs.txt"), "file '/etc/x.wav'\n");
	writeFileSync(join(w, "sub/drive.txt"), "file 'C:/x.wav'\n");
	writeFileSync(join(w, "sub/back.txt"), "file 'etc\\x.wav'\n");
	writeFileSync(join(w, "sub/rel.txt"), "file 'etc/x.wav'\n");
	writeFileSync(join(w, "fake.wav"), "#EXTM3U\nhttp://127.0.0.1:1/x\n");
	symlinkSync("/etc/hosts", join(w, "link.wav"));
});

const ok = (c: string) => ffmpegInProject(c, w).ok;

// The lane has no opinion on win32 by design (see "win32: no opinion" below), so nothing passes there.
describe.skipIf(process.platform === "win32")("ffmpegInProject passes", () => {
	test("slide plus narration into a segment", () => {
		expect(
			ok(
				"ffmpeg -y -loop 1 -i video/slide1.png -i video/n1.wav -t 4.8 -c:v libx264 -pix_fmt yuv420p -r 25 -c:a aac -shortest video/out1.mp4",
			),
		).toBe(true);
		expect(
			ok(
				"ffmpeg -loop 1 -i slide1.png -i n1.wav -shortest -vf scale=1280:720,format=yuv420p out.mp4",
			),
		).toBe(true);
	});
	test("concat of a vetted list, -safe 0 included", () => {
		expect(ok("ffmpeg -y -f concat -safe 0 -i video/list.txt -c copy video/brief.mp4")).toBe(true);
	});
});

describe("ffmpegInProject concat entries and platform (8SO on #3960)", () => {
	const cat = (l: string) => `ffmpeg -f concat -safe 0 -i ${l} -c copy out9.wav`;
	test.each(["sub/abs.txt", "sub/drive.txt", "sub/back.txt"])(
		"absolute, drive-letter or backslash entry is refused: %s",
		(l) => {
			expect(ok(cat(l))).toBe(false);
		},
	);
	test.skipIf(process.platform === "win32")(
		"a relative entry in the same folder still passes",
		() => {
			expect(ok(cat("sub/rel.txt"))).toBe(true);
		},
	);
	test("win32: no opinion", () => {
		const real = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(ok("ffmpeg -loop 1 -i slide1.png -i n1.wav -shortest out8.mp4")).toBe(false);
		} finally {
			if (real) Object.defineProperty(process, "platform", real);
		}
	});
});

describe("ffmpegInProject refuses", () => {
	test.each([
		["endless loop", "ffmpeg -loop 1 -i slide1.png -i n1.wav out.mp4"],
		["output exists", "ffmpeg -y -i video/seg1.mp4 -c copy video/seg2.mp4"],
		["absolute output", "ffmpeg -i n1.wav /tmp/x.wav"],
		["outside output", "ffmpeg -i n1.wav ../x.wav"],
		["code output", "ffmpeg -i n1.wav build.sh"],
		["pipe", "ffmpeg -i n1.wav -f wav pipe:1"],
		["url input", "ffmpeg -i http://127.0.0.1/a.mp4 out.mp4"],
		["protocol", "ffmpeg -i concat:a.wav|n1.wav out.wav"],
		["lavfi", "ffmpeg -f lavfi -i testsrc out.mp4"],
		["text posing as wav", "ffmpeg -i fake.wav out.wav"],
		["symlink input", "ffmpeg -i link.wav out.wav"],
		["concat list outside", "ffmpeg -f concat -safe 0 -i video/evil.txt -c copy out.mp4"],
		["concat list parent", "ffmpeg -f concat -safe 0 -i video/up.txt -c copy out.mp4"],
		["drawtext filter", "ffmpeg -i slide1.png -vf drawtext=textfile=n1.wav out.mp4"],
		["movie filter", "ffmpeg -i slide1.png -vf movie=n1.wav out.mp4"],
		["unknown option", "ffmpeg -i n1.wav -dump out.wav"],
		["chain", "ffmpeg -i n1.wav out.wav && ls"],
		["semicolon", "ffmpeg -i n1.wav out.wav; ls"],
		["redirect", "ffmpeg -i n1.wav out.wav 2>/dev/null"],
		["variable", "ffmpeg -i $HOME/n1.wav out.wav"],
		["glob", "ffmpeg -i video/*.png out.mp4"],
		["too long", "ffmpeg -i n1.wav -t 9999 out.wav"],
		["no output", "ffmpeg -i n1.wav -t 3"],
		["dot dir output", "ffmpeg -i n1.wav .git/x.wav"],
	])("%s", (_n, c) => expect(ok(c)).toBe(false));
	test("no cwd", () => expect(ffmpegInProject("ffmpeg -i n1.wav o.wav", undefined).ok).toBe(false));
});
