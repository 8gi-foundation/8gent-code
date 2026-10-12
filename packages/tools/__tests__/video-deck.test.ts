/** render_video_deck: schema, deterministic render, cwd confinement, no network. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { ToolExecutor } from "../../eight/tools";
import { DeckSpecSchema, buildFfmpegArgs, paintSlide, renderVideoDeck } from "../video-deck";

afterAll(cleanupTempDirs);

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const ffTest = hasFfmpeg ? test : test.skip;

const SPEC = {
	title: "Brief",
	slides: [
		{ kicker: "Why", title: "Two slides", bullets: ["one thing", "another thing"], seconds: 1 },
		{ title: "The end", text: "Plain text slide.", seconds: 1 },
	],
};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const probe = (f: string) =>
	spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,nb_frames:format=duration", "-of", "json", f])
		.stdout.toString();
/** Decoded frame hashes: container bytes may differ, pixels must not. */
const frameHashes = (f: string) =>
	spawnSync("ffmpeg", ["-v", "error", "-i", f, "-f", "framemd5", "-"]).stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()?.trim());

describe("deck spec schema", () => {
	test("accepts a valid spec and defaults size", () => {
		const p = DeckSpecSchema.parse(SPEC);
		expect(p.size).toBe("1280x720");
	});
	test("rejects empty slides, empty slide, unknown keys, bad seconds, too many slides", () => {
		expect(DeckSpecSchema.safeParse({ slides: [] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: [{ kicker: "only" }] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: [{ title: "a", shell: "rm -rf" }] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: [{ title: "a", seconds: 999 }] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: Array.from({ length: 41 }, () => ({ title: "a" })) }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ size: "4k", slides: [{ title: "a" }] }).success).toBe(false);
	});
});

describe("render", () => {
	test("painting is a pure function of the slide", async () => {
		const root = tempDir("vdeck-paint-");
		const a = await paintSlide(SPEC.slides[0], "1280x720", root, "Brief");
		const b = await paintSlide(SPEC.slides[0], "1280x720", root, "Brief");
		expect(sha(a)).toBe(sha(b));
	});

	ffTest("golden 2-slide render is deterministic and has the expected layout", async () => {
		const root = tempDir("vdeck-golden-");
		const r1 = await renderVideoDeck({ spec: SPEC, out: join(root, "a.mp4"), cwd: root });
		const r2 = await renderVideoDeck({ spec: SPEC, out: join(root, "b.mp4"), cwd: root });
		expect(r1.slides).toBe(2);
		expect(r1.hasAudio).toBe(false);
		expect(r1.durationSec).toBeCloseTo(2, 1);
		expect(r2.durationSec).toBe(r1.durationSec);
		expect(probe(join(root, "a.mp4"))).toBe(probe(join(root, "b.mp4")));
		const info = JSON.parse(probe(join(root, "a.mp4")));
		expect(info.streams).toHaveLength(1);
		expect(info.streams[0]).toMatchObject({ codec_name: "h264", width: 1280, height: 720, nb_frames: "48" });
		expect(frameHashes(join(root, "a.mp4"))).toEqual(frameHashes(join(root, "b.mp4")));
		expect(sha(readFileSync(join(root, "a.mp4")))).toBe(sha(readFileSync(join(root, "b.mp4"))));
		expect(existsSync(join(root, ".tmp")) ? require("node:fs").readdirSync(join(root, ".tmp")) : []).toEqual([]);
	});

	ffTest("narration through a local engine adds an audio stream and stretches the slide", async () => {
		const root = tempDir("vdeck-vo-");
		const stub = join(root, "st");
		writeFileSync(
			stub,
			`#!/usr/bin/env bash
OUT="$3"
python3 - "$OUT" <<'PY'
import sys,struct
d=b'\\0\\0'*24000
open(sys.argv[1],'wb').write(b'RIFF'+struct.pack('<I',36+len(d))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,16000,2,16)+b'data'+struct.pack('<I',len(d))+d)
PY
`,
		);
		chmodSync(stub, 0o755);
		process.env.EIGHT_SUPERTONIC_BIN = stub;
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		const spec = { slides: [{ title: "Hi", seconds: 1, narration: "hello there" }, { title: "Quiet", seconds: 1 }] };
		const r = await renderVideoDeck({ spec, out: join(root, "v.mp4"), cwd: root });
		expect(r.hasAudio).toBe(true);
		// 3s of speech + 1s pad on slide one, 1s on slide two.
		expect(r.durationSec).toBeCloseTo(5, 1);
		const info = JSON.parse(probe(join(root, "v.mp4")));
		expect(info.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(["aac", "h264"]);
	});
});

describe("confinement", () => {
	test("out outside the working directory, non-mp4, and symlinks are refused", async () => {
		const root = tempDir("vdeck-esc-");
		const work = join(root, "work");
		mkdirSync(work);
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(work, "link"));
		const ex = new ToolExecutor(work);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "../x.mp4" })).toMatch(/traversal|blocked/i);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: join(root, "abs.mp4") })).toMatch(/traversal|blocked/i);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "a.mov" })).toMatch(/\.mp4/);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "link/v.mp4" })).toMatch(/traversal|blocked|symlink/i);
		for (const f of ["x.mp4", "abs.mp4"]) expect(existsSync(join(root, f))).toBe(false);
		expect(existsSync(join(root, "outside", "v.mp4"))).toBe(false);
	});

	test("an image outside the working directory or at a URL is refused", async () => {
		const root = tempDir("vdeck-img-");
		const work = join(root, "work");
		mkdirSync(work);
		writeFileSync(join(root, "secret.png"), "x");
		const bad = (image: string) => ({ slides: [{ title: "t", image }] });
		await expect(renderVideoDeck({ spec: bad("../secret.png"), out: join(work, "o.mp4"), cwd: work })).rejects.toThrow(/traversal/i);
		await expect(renderVideoDeck({ spec: bad("http://127.0.0.1:9/a.png"), out: join(work, "o.mp4"), cwd: work })).rejects.toThrow(/URL/);
		await expect(renderVideoDeck({ spec: bad("file:///etc/hosts"), out: join(work, "o.mp4"), cwd: work })).rejects.toThrow(/URL/);
		expect(existsSync(join(work, "o.mp4"))).toBe(false);
	});

	test("an edit-scoped sub-agent cannot render outside its scope", async () => {
		const root = tempDir("vdeck-scope-");
		mkdirSync(join(root, "allowed"));
		const ex = new ToolExecutor(root, "child", undefined, { allowedPaths: ["allowed"] });
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "other.mp4" })).toContain("SCOPE BLOCKED");
		expect(existsSync(join(root, "other.mp4"))).toBe(false);
	});

	test("an invalid spec is refused before anything is written", async () => {
		const root = tempDir("vdeck-bad-");
		const r = await new ToolExecutor(root).execute("render_video_deck", { spec: { slides: [] }, out: "v.mp4" });
		expect(r).toMatch(/invalid deck spec/);
		expect(existsSync(join(root, "v.mp4"))).toBe(false);
	});
});

describe("no network", () => {
	test("ffmpeg argv restricts every input to the file protocol and uses no shell string", () => {
		const args = buildFfmpegArgs([{ png: "/w/a.png", sec: 1 }, { png: "/w/b.png", sec: 1, wav: "/w/a.wav" }], "/w/o.mp4", true);
		const inputs = args.reduce<number[]>((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
		expect(inputs).toHaveLength(3);
		for (const i of inputs) expect(args.slice(0, i)).toContain("-protocol_whitelist");
		let prev = -1;
		for (const i of inputs) {
			const w = args.indexOf("-protocol_whitelist", prev + 1);
			expect(w).toBeGreaterThan(prev);
			expect(w).toBeLessThan(i);
			expect(args[w + 1]).toBe("file");
			expect(args[i + 1]).toMatch(/^\/w\//);
			prev = i;
		}
		expect(args.join(" ")).not.toMatch(/https?:|ftp:|tcp:|rtmp/);
	});

	ffTest("a full render makes no fetch and opens no socket in-process", async () => {
		const root = tempDir("vdeck-net-");
		const realFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			throw new Error("network used");
		}) as unknown as typeof fetch;
		try {
			await renderVideoDeck({ spec: SPEC, out: join(root, "n.mp4"), cwd: root });
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(calls).toBe(0);
		const src = readFileSync(join(import.meta.dir, "..", "video-deck.ts"), "utf8");
		expect(src).not.toMatch(/from "node:(http|https|net|dgram|tls)"|\bfetch\(|XMLHttpRequest|WebSocket/);
	});
});
