/** render_video_deck: schema, deterministic render, cwd confinement, no network. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { ToolExecutor } from "../../eight/tools";
import { editScopeViolation, scopedWriteTarget, SCOPED_WRITE_TOOLS } from "../../permissions/edit-guards";
import { agentTools, setToolContext } from "../../ai/tools";
import { ModeManager } from "../../eight/modes";
import { MAX_IMAGE_BYTES, DeckSpecSchema, buildFfmpegArgs, imageDimensions, paintSlide, placeOutput, renderVideoDeck, resolveBinary } from "../video-deck";

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

const which = (n: string) => spawnSync("which", [n]).stdout.toString().trim();

describe("edit scope on every path (review)", () => {
	test("render_video_deck is a scoped write tool with its target in out", () => {
		expect(SCOPED_WRITE_TOOLS.has("render_video_deck")).toBe(true);
		expect(scopedWriteTarget("render_video_deck", { out: "a.mp4", path: "z" })).toBe("a.mp4");
		expect(scopedWriteTarget("speak", { out: "a.wav" })).toBe("a.wav");
		expect(scopedWriteTarget("write_file", { path: "p" })).toBe("p");
		expect(editScopeViolation("render_video_deck", { out: "other.mp4" }, "/w", ["allowed"])).toContain("SCOPE BLOCKED");
		expect(editScopeViolation("render_video_deck", {}, "/w", ["allowed"])).toContain("SCOPE BLOCKED");
		expect(editScopeViolation("render_video_deck", { out: "allowed/a.mp4" }, "/w", ["allowed"])).toBeNull();
	});

	test("native handler refuses outside the agent's scope and nothing is written", async () => {
		const root = tempDir("vdeck-native-");
		mkdirSync(join(root, "allowed"));
		const run = (a: Record<string, unknown>, allowedPaths?: string[]) =>
			{
				setToolContext({ workingDirectory: root, allowedPaths });
				return (agentTools.render_video_deck as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(a, {
					toolCallId: "t",
					messages: [],
				});
			};
		expect(await run({ spec: SPEC, out: "other.mp4" }, ["allowed"])).toContain("SCOPE BLOCKED");
		expect(existsSync(join(root, "other.mp4"))).toBe(false);
		if (hasFfmpeg) {
			const ok = JSON.parse(await run({ spec: SPEC, out: "allowed/ok.mp4" }, ["allowed"]));
			expect(existsSync(ok.path)).toBe(true);
		}
	});

	test("architect and review modes deny the media write tools", () => {
		for (const m of ["architect", "review"]) {
			const denied = new ModeManager("/nonexistent/modes.yaml").getMode(m)?.deniedTools ?? [];
			for (const t of ["speak", "make_pdf", "render_video_deck"]) expect(denied).toContain(t);
		}
	});
});

describe("final write is re-checked (TOCTOU)", () => {
	// A stub ffmpeg that runs the real one, then swaps a link in before the tool copies the result out.
	function swapper(root: string, swapCmd: string) {
		const stub = join(root, "stub-bin", "ffmpeg");
		mkdirSync(join(root, "stub-bin"));
		writeFileSync(stub, `#!/usr/bin/env bash\n${which("ffmpeg")} "$@" || exit $?\n${swapCmd}\n`);
		chmodSync(stub, 0o755);
		return stub;
	}

	ffTest("deck.mp4 swapped for a symlink to an outside file: the outside file is untouched", async () => {
		const base = tempDir("vdeck-toctou1-");
		const work = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(work);
		mkdirSync(outside);
		writeFileSync(join(outside, "victim.mp4"), "keep");
		const stub = swapper(base, `ln -sf ${join(outside, "victim.mp4")} ${join(work, "deck.mp4")}`);
		await renderVideoDeck({ spec: SPEC, out: join(work, "deck.mp4"), cwd: work, ffmpeg: stub });
		expect(readFileSync(join(outside, "victim.mp4"), "utf8")).toBe("keep");
		// the link was replaced by a real file, not written through
		expect(spawnSync("test", ["-L", join(work, "deck.mp4")]).status).not.toBe(0);
		expect(readFileSync(join(work, "deck.mp4")).length).toBeGreaterThan(1000);
	});

	ffTest("parent directory swapped for a symlink outside cwd: refused, outside dir untouched", async () => {
		const base = tempDir("vdeck-toctou2-");
		const work = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(join(work, "sub"), { recursive: true });
		mkdirSync(outside);
		const stub = swapper(base, `rm -rf ${join(work, "sub")} && ln -s ${outside} ${join(work, "sub")}`);
		await expect(renderVideoDeck({ spec: SPEC, out: join(work, "sub", "deck.mp4"), cwd: work, ffmpeg: stub })).rejects.toThrow(/traversal|outside|ENOENT/i);
		expect(readdirSync(outside)).toEqual([]);
	});

	test("placeOutput refuses a parent that resolves outside and leaves no part file", () => {
		const base = tempDir("vdeck-place-");
		const work = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(work);
		mkdirSync(outside);
		symlinkSync(outside, join(work, "link"));
		writeFileSync(join(base, "src.mp4"), "data");
		expect(() => placeOutput(join(base, "src.mp4"), join(work, "link", "d.mp4"), work)).toThrow(/traversal/i);
		expect(readdirSync(outside)).toEqual([]);
	});

	ffTest("a symlinked .tmp scratch root is refused", async () => {
		const base = tempDir("vdeck-tmplink-");
		const work = join(base, "work");
		mkdirSync(work);
		mkdirSync(join(base, "outside"));
		symlinkSync(join(base, "outside"), join(work, ".tmp"));
		await expect(renderVideoDeck({ spec: SPEC, out: join(work, "d.mp4"), cwd: work })).rejects.toThrow(/\.tmp/);
		expect(readdirSync(join(base, "outside"))).toEqual([]);
	});
});

describe("caps", () => {
	const png = (w: number, h: number) => {
		const b = Buffer.alloc(33);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
		b.write("IHDR", 12);
		b.writeUInt32BE(w, 16);
		b.writeUInt32BE(h, 20);
		return b;
	};

	test("header parsing reads PNG and JPEG sizes", () => {
		expect(imageDimensions(png(300, 200))).toEqual({ width: 300, height: 200 });
		const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 150, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
		expect(imageDimensions(jpg)).toEqual({ width: 150, height: 100 });
		expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
	});

	test("an image over the pixel cap is refused from its header, before decoding", async () => {
		const root = tempDir("vdeck-px-");
		writeFileSync(join(root, "big.png"), png(20000, 20000));
		await expect(renderVideoDeck({ spec: { slides: [{ title: "t", image: "big.png" }] }, out: join(root, "o.mp4"), cwd: root })).rejects.toThrow(/pixels/);
	});

	test("an image over the byte cap is refused", async () => {
		const root = tempDir("vdeck-bytes-");
		const b = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		png(10, 10).copy(b);
		writeFileSync(join(root, "fat.png"), b);
		await expect(renderVideoDeck({ spec: { slides: [{ title: "t", image: "fat.png" }] }, out: join(root, "o.mp4"), cwd: root })).rejects.toThrow(/bytes/);
	});

	test("total seconds over 600 are refused", async () => {
		const root = tempDir("vdeck-secs-");
		const slides = Array.from({ length: 11 }, () => ({ title: "t", seconds: 60 }));
		await expect(renderVideoDeck({ spec: { slides }, out: join(root, "o.mp4"), cwd: root })).rejects.toThrow(/limit is 600/);
		expect(existsSync(join(root, "o.mp4"))).toBe(false);
	});

	test("one deadline covers narration", async () => {
		const root = tempDir("vdeck-deadline-");
		const stub = join(root, "slow");
		writeFileSync(stub, "#!/usr/bin/env bash\nsleep 5\n");
		chmodSync(stub, 0o755);
		process.env.EIGHT_SUPERTONIC_BIN = stub;
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		const t0 = Date.now();
		await expect(
			renderVideoDeck({ spec: { slides: [{ title: "t", narration: "hello" }] }, out: join(root, "o.mp4"), cwd: root, deadlineMs: 700 }),
		).rejects.toThrow(/deadline/);
		expect(Date.now() - t0).toBeLessThan(4000);
	});

	test("relative PATH entries never win and a binary inside the workspace is refused", () => {
		const base = tempDir("vdeck-bin-");
		const work = join(base, "work");
		mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
		const fake = join(work, "node_modules", ".bin", "ffmpeg");
		writeFileSync(fake, "#!/bin/sh\n");
		chmodSync(fake, 0o755);
		// relative entry is skipped entirely
		expect(() => resolveBinary("ffmpeg", work, undefined, "node_modules/.bin")).toThrow(/not found/);
		expect(() => resolveBinary("ffmpeg", work, undefined, ".")).toThrow(/not found/);
		// absolute entry inside the workspace is refused
		expect(() => resolveBinary("ffmpeg", work, undefined, join(work, "node_modules", ".bin"))).toThrow(/inside the working directory/);
		// symlink out of a clean dir into the workspace is refused too
		mkdirSync(join(base, "clean"));
		symlinkSync(fake, join(base, "clean", "ffmpeg"));
		expect(() => resolveBinary("ffmpeg", work, undefined, join(base, "clean"))).toThrow(/inside the working directory/);
		// an override must be absolute
		expect(() => resolveBinary("ffmpeg", work, "ffmpeg")).toThrow(/absolute/);
		if (hasFfmpeg) expect(resolveBinary("ffmpeg", work)).toMatch(/^\//);
	});
});
