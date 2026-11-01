/** render_video_deck: schema, deterministic render, cwd confinement, no network. */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fakeExecutable } from "../../../tests/fake-exe";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { agentTools, setToolContext } from "../../ai/tools";
import { ModeManager } from "../../eight/modes";
import { ToolExecutor } from "../../eight/tools";
import {
	SCOPED_WRITE_TOOLS,
	editScopeViolation,
	scopedWriteTarget,
} from "../../permissions/edit-guards";
import {
	DeckSpecSchema,
	FPS,
	INTRO_FRAMES,
	MAX_IMAGE_BYTES,
	RENDER_VIDEO_DECK_DESCRIPTION,
	buildFfmpegArgs,
	chapterLines,
	clock,
	imageDimensions,
	paintSlide,
	phase,
	placeOutput,
	renderVideoDeck,
	resolveBinary,
} from "../video-deck";

afterAll(cleanupTempDirs);

const hasFfmpeg =
	spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
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
	spawnSync("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"stream=codec_name,width,height,nb_frames:format=duration",
		"-of",
		"json",
		f,
	]).stdout.toString();
/** Decoded frame hashes: container bytes may differ, pixels must not. */
const frameHashes = (f: string) =>
	spawnSync("ffmpeg", ["-v", "error", "-i", f, "-f", "framemd5", "-"])
		.stdout.toString()
		.split("\n")
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => l.split(",").pop()?.trim());

describe("deck spec schema", () => {
	test("accepts a valid spec and defaults size", () => {
		const p = DeckSpecSchema.parse(SPEC);
		expect(p.size).toBe("1280x720");
	});
	test("rejects empty slides, empty slide, unknown keys, bad seconds, too many slides", () => {
		expect(DeckSpecSchema.safeParse({ slides: [] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: [{ kicker: "only" }] }).success).toBe(false);
		expect(DeckSpecSchema.safeParse({ slides: [{ title: "a", shell: "rm -rf" }] }).success).toBe(
			false,
		);
		expect(DeckSpecSchema.safeParse({ slides: [{ title: "a", seconds: 999 }] }).success).toBe(
			false,
		);
		expect(
			DeckSpecSchema.safeParse({ slides: Array.from({ length: 41 }, () => ({ title: "a" })) })
				.success,
		).toBe(false);
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
		expect(info.streams[0]).toMatchObject({
			codec_name: "h264",
			width: 1280,
			height: 720,
			nb_frames: "48",
		});
		expect(frameHashes(join(root, "a.mp4"))).toEqual(frameHashes(join(root, "b.mp4")));
		expect(sha(readFileSync(join(root, "a.mp4")))).toBe(sha(readFileSync(join(root, "b.mp4"))));
		expect(
			existsSync(join(root, ".tmp")) ? require("node:fs").readdirSync(join(root, ".tmp")) : [],
		).toEqual([]);
	});

	ffTest(
		"narration through a local engine adds an audio stream and stretches the slide",
		async () => {
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
			const spec = {
				slides: [
					{ title: "Hi", seconds: 1, narration: "hello there" },
					{ title: "Quiet", seconds: 1 },
				],
			};
			const r = await renderVideoDeck({ spec, out: join(root, "v.mp4"), cwd: root });
			expect(r.hasAudio).toBe(true);
			// 3s of speech + 1s pad on slide one, 1s on slide two.
			expect(r.durationSec).toBeCloseTo(5, 1);
			const info = JSON.parse(probe(join(root, "v.mp4")));
			expect(info.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual([
				"aac",
				"h264",
			]);
		},
	);

	ffTest(
		"two narrated slides: sound and picture are the same length, all numbers measured (#4165)",
		async () => {
			const root = tempDir("vdeck-sync-");
			const stub = fakeExecutable(
				root,
				"st",
				// Supertonic stand-in: argv is tts -o OUT --voice ID ...; writes a 2.5 s silent 8 kHz wav.
				`const fs=require("node:fs");const out=process.argv[process.argv.indexOf("-o")+1];
const d=Buffer.alloc(2*8000*2.5);const h=Buffer.alloc(44);
h.write("RIFF",0);h.writeUInt32LE(36+d.length,4);h.write("WAVEfmt ",8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);
h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);
h.write("data",36);h.writeUInt32LE(d.length,40);fs.writeFileSync(out,Buffer.concat([h,d]));`,
			);
			process.env.EIGHT_SUPERTONIC_BIN = stub;
			process.env.EIGHT_KITTEN_PY = "/nonexistent";
			const spec = {
				slides: [
					{ title: "One", seconds: 1, narration: "first line" },
					{ title: "Two", seconds: 1, narration: "second line" },
				],
			};
			const r = await renderVideoDeck({ spec, out: join(root, "v.mp4"), cwd: root });
			const info = JSON.parse(probe(join(root, "v.mp4"))) as {
				streams: { codec_name: string; width?: number; height?: number }[];
				format: { duration: string };
			};
			const v = info.streams.find((s) => s.codec_name === "h264");
			expect(r.slides).toBe(2);
			expect([r.width, r.height]).toEqual([v?.width ?? 0, v?.height ?? 0]);
			expect([r.width, r.height]).toEqual([1280, 720]);
			expect(r.durationSec).toBeCloseTo(Number(info.format.duration), 2);
			// Each slide holds 2.5 s of voice + 1 s pad = 3.5 s, so 7 s in all.
			expect(r.videoSec).toBeCloseTo(7, 1);
			expect(r.audioSec).not.toBeNull();
			expect(Math.abs((r.audioSec ?? 0) - r.videoSec)).toBeLessThanOrEqual(0.2);
		},
	);

	ffTest("a file that does not match the spec is refused and never placed (#4165)", async () => {
		const root = tempDir("vdeck-probe-");
		// The stand-ins live outside the project: a binary inside it is refused on its own.
		const bins = tempDir("vdeck-probe-bin-");
		const bad = fakeExecutable(
			bins,
			"ffprobe-small",
			`process.stdout.write(JSON.stringify({streams:[{codec_type:"video",width:640,height:360,duration:"2.0"}],format:{duration:"2.0"}}));`,
		);
		await expect(
			renderVideoDeck({ spec: SPEC, out: join(root, "v.mp4"), cwd: root, ffprobe: bad }),
		).rejects.toThrow(/640x360, not the 1280x720/);
		expect(existsSync(join(root, "v.mp4"))).toBe(false);
		const none = fakeExecutable(bins, "ffprobe-none", `process.stdout.write("{}");`);
		await expect(
			renderVideoDeck({ spec: SPEC, out: join(root, "w.mp4"), cwd: root, ffprobe: none }),
		).rejects.toThrow(/could not read a video stream/);
		expect(existsSync(join(root, "w.mp4"))).toBe(false);
		// Nothing is left behind: no .deck-*.part beside the output, no work folder in .tmp.
		expect(readdirSync(root).filter((f) => f.endsWith(".part"))).toEqual([]);
		expect(readdirSync(join(root, ".tmp"))).toEqual([]);
	});

	ffTest(
		"a narrated deck whose file has no audio stream is refused and never placed (#4165 review)",
		async () => {
			const root = tempDir("vdeck-noaudio-");
			const bins = tempDir("vdeck-noaudio-bin-");
			const tts = fakeExecutable(
				bins,
				"st",
				// Supertonic stand-in: writes a 1 s silent 8 kHz wav to the path after -o.
				`const fs=require("node:fs");const out=process.argv[process.argv.indexOf("-o")+1];
const d=Buffer.alloc(2*8000);const h=Buffer.alloc(44);
h.write("RIFF",0);h.writeUInt32LE(36+d.length,4);h.write("WAVEfmt ",8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);
h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);
h.write("data",36);h.writeUInt32LE(d.length,40);fs.writeFileSync(out,Buffer.concat([h,d]));`,
			);
			const silent = fakeExecutable(
				bins,
				"ffprobe-silent",
				`process.stdout.write(JSON.stringify({streams:[{codec_type:"video",width:1280,height:720,duration:"2.0"}],format:{duration:"2.0"}}));`,
			);
			const saved = [process.env.EIGHT_SUPERTONIC_BIN, process.env.EIGHT_KITTEN_PY];
			process.env.EIGHT_SUPERTONIC_BIN = tts;
			process.env.EIGHT_KITTEN_PY = "/nonexistent";
			try {
				const spec = { slides: [{ title: "Hi", seconds: 1, narration: "hello there" }] };
				await expect(
					renderVideoDeck({ spec, out: join(root, "v.mp4"), cwd: root, ffprobe: silent }),
				).rejects.toThrow(/no audio stream although slides carry narration/);
			} finally {
				for (const [k, v] of [
					["EIGHT_SUPERTONIC_BIN", saved[0]],
					["EIGHT_KITTEN_PY", saved[1]],
				] as const) {
					if (v === undefined) Reflect.deleteProperty(process.env, k);
					else process.env[k] = v;
				}
			}
			expect(existsSync(join(root, "v.mp4"))).toBe(false);
			expect(readdirSync(root).filter((f) => f.endsWith(".part"))).toEqual([]);
			expect(readdirSync(join(root, ".tmp"))).toEqual([]);
		},
	);

	test("a deferred session can load it: render_video_deck sits in the creative category (#4165)", async () => {
		const { ToolRegistry } = await import("../../eight/tool-registry");
		expect(new ToolRegistry(false).loadCategory("creative")).toContain("render_video_deck");
	});

	test("missing ffmpeg is reported plainly, after the spec is checked (#4165)", async () => {
		const root = tempDir("vdeck-noff-");
		await expect(
			renderVideoDeck({
				spec: SPEC,
				out: join(root, "v.mp4"),
				cwd: root,
				ffmpeg: join(root, "no-ffmpeg"),
			}),
		).rejects.toThrow(/ffmpeg not found at/);
		expect(existsSync(join(root, "v.mp4"))).toBe(false);
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
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "../x.mp4" })).toMatch(
			/traversal|blocked/i,
		);
		expect(
			await ex.execute("render_video_deck", { spec: SPEC, out: join(root, "abs.mp4") }),
		).toMatch(/traversal|blocked/i);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "a.mov" })).toMatch(/\.mp4/);
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "link/v.mp4" })).toMatch(
			/traversal|blocked|symlink/i,
		);
		for (const f of ["x.mp4", "abs.mp4"]) expect(existsSync(join(root, f))).toBe(false);
		expect(existsSync(join(root, "outside", "v.mp4"))).toBe(false);
	});

	test("an image outside the working directory or at a URL is refused", async () => {
		const root = tempDir("vdeck-img-");
		const work = join(root, "work");
		mkdirSync(work);
		writeFileSync(join(root, "secret.png"), "x");
		const bad = (image: string) => ({ slides: [{ title: "t", image }] });
		await expect(
			renderVideoDeck({ spec: bad("../secret.png"), out: join(work, "o.mp4"), cwd: work }),
		).rejects.toThrow(/traversal/i);
		await expect(
			renderVideoDeck({
				spec: bad("http://127.0.0.1:9/a.png"),
				out: join(work, "o.mp4"),
				cwd: work,
			}),
		).rejects.toThrow(/URL/);
		await expect(
			renderVideoDeck({ spec: bad("file:///etc/hosts"), out: join(work, "o.mp4"), cwd: work }),
		).rejects.toThrow(/URL/);
		expect(existsSync(join(work, "o.mp4"))).toBe(false);
	});

	test("an edit-scoped sub-agent cannot render outside its scope", async () => {
		const root = tempDir("vdeck-scope-");
		mkdirSync(join(root, "allowed"));
		const ex = new ToolExecutor(root, "child", undefined, { allowedPaths: ["allowed"] });
		expect(await ex.execute("render_video_deck", { spec: SPEC, out: "other.mp4" })).toContain(
			"SCOPE BLOCKED",
		);
		expect(existsSync(join(root, "other.mp4"))).toBe(false);
	});

	test("an invalid spec is refused before anything is written", async () => {
		const root = tempDir("vdeck-bad-");
		const r = await new ToolExecutor(root).execute("render_video_deck", {
			spec: { slides: [] },
			out: "v.mp4",
		});
		expect(r).toMatch(/invalid deck spec/);
		expect(existsSync(join(root, "v.mp4"))).toBe(false);
	});
});

describe("no network", () => {
	test("ffmpeg argv restricts every input to the file protocol and uses no shell string", () => {
		const args = buildFfmpegArgs(
			[
				{ png: "/w/a.png", sec: 1 },
				{ png: "/w/b.png", sec: 1, wav: "/w/a.wav" },
			],
			"/w/o.mp4",
			true,
		);
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
		expect(src).not.toMatch(
			/from "node:(http|https|net|dgram|tls)"|\bfetch\(|XMLHttpRequest|WebSocket/,
		);
	});
});

const which = (n: string) => spawnSync("which", [n]).stdout.toString().trim();

describe("edit scope on every path (review)", () => {
	test("render_video_deck is a scoped write tool with its target in out", () => {
		expect(SCOPED_WRITE_TOOLS.has("render_video_deck")).toBe(true);
		expect(scopedWriteTarget("render_video_deck", { out: "a.mp4", path: "z" })).toBe("a.mp4");
		expect(scopedWriteTarget("speak", { out: "a.wav" })).toBe("a.wav");
		expect(scopedWriteTarget("write_file", { path: "p" })).toBe("p");
		expect(
			editScopeViolation("render_video_deck", { out: "other.mp4" }, "/w", ["allowed"]),
		).toContain("SCOPE BLOCKED");
		expect(editScopeViolation("render_video_deck", {}, "/w", ["allowed"])).toContain(
			"SCOPE BLOCKED",
		);
		expect(
			editScopeViolation("render_video_deck", { out: "allowed/a.mp4" }, "/w", ["allowed"]),
		).toBeNull();
	});

	test("native handler refuses outside the agent's scope and nothing is written", async () => {
		const root = tempDir("vdeck-native-");
		mkdirSync(join(root, "allowed"));
		const run = (a: Record<string, unknown>, allowedPaths?: string[]) => {
			setToolContext({ workingDirectory: root, allowedPaths });
			return (
				agentTools.render_video_deck as unknown as {
					execute: (a: unknown, o: unknown) => Promise<string>;
				}
			).execute(a, {
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

	ffTest(
		"deck.mp4 swapped for a symlink to an outside file: the outside file is untouched",
		async () => {
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
		},
	);

	ffTest(
		"parent directory swapped for a symlink outside cwd: refused, outside dir untouched",
		async () => {
			const base = tempDir("vdeck-toctou2-");
			const work = join(base, "work");
			const outside = join(base, "outside");
			mkdirSync(join(work, "sub"), { recursive: true });
			mkdirSync(outside);
			const stub = swapper(
				base,
				`rm -rf ${join(work, "sub")} && ln -s ${outside} ${join(work, "sub")}`,
			);
			await expect(
				renderVideoDeck({
					spec: SPEC,
					out: join(work, "sub", "deck.mp4"),
					cwd: work,
					ffmpeg: stub,
				}),
			).rejects.toThrow(/traversal|outside|ENOENT/i);
			expect(readdirSync(outside)).toEqual([]);
		},
	);

	test("placeOutput refuses a parent that resolves outside and leaves no part file", () => {
		const base = tempDir("vdeck-place-");
		const work = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(work);
		mkdirSync(outside);
		symlinkSync(outside, join(work, "link"));
		writeFileSync(join(base, "src.mp4"), "data");
		expect(() => placeOutput(join(base, "src.mp4"), join(work, "link", "d.mp4"), work)).toThrow(
			/traversal/i,
		);
		expect(readdirSync(outside)).toEqual([]);
	});

	ffTest("a symlinked .tmp scratch root is refused", async () => {
		const base = tempDir("vdeck-tmplink-");
		const work = join(base, "work");
		mkdirSync(work);
		mkdirSync(join(base, "outside"));
		symlinkSync(join(base, "outside"), join(work, ".tmp"));
		await expect(
			renderVideoDeck({ spec: SPEC, out: join(work, "d.mp4"), cwd: work }),
		).rejects.toThrow(/\.tmp/);
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
		const jpg = Buffer.from([
			0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 150, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
		]);
		expect(imageDimensions(jpg)).toEqual({ width: 150, height: 100 });
		expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
	});

	test("an image over the pixel cap is refused from its header, before decoding", async () => {
		const root = tempDir("vdeck-px-");
		writeFileSync(join(root, "big.png"), png(20000, 20000));
		await expect(
			renderVideoDeck({
				spec: { slides: [{ title: "t", image: "big.png" }] },
				out: join(root, "o.mp4"),
				cwd: root,
			}),
		).rejects.toThrow(/pixels/);
	});

	test("an image over the byte cap is refused", async () => {
		const root = tempDir("vdeck-bytes-");
		const b = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		png(10, 10).copy(b);
		writeFileSync(join(root, "fat.png"), b);
		await expect(
			renderVideoDeck({
				spec: { slides: [{ title: "t", image: "fat.png" }] },
				out: join(root, "o.mp4"),
				cwd: root,
			}),
		).rejects.toThrow(/bytes/);
	});

	test("total seconds over 600 are refused", async () => {
		const root = tempDir("vdeck-secs-");
		const slides = Array.from({ length: 11 }, () => ({ title: "t", seconds: 60 }));
		await expect(
			renderVideoDeck({ spec: { slides }, out: join(root, "o.mp4"), cwd: root }),
		).rejects.toThrow(/limit is 600/);
		expect(existsSync(join(root, "o.mp4"))).toBe(false);
	});

	/**
	 * A narration engine that never finishes: a real executable on every OS (see
	 * tests/fake-exe.ts). With a pidfile it writes its pid there, and with
	 * ignoreTerm it shrugs off SIGTERM so only SIGKILL ends it. Both are baked into
	 * the script: the engine child gets an allowlisted env, not the test's process.env.
	 */
	const slowEngine = (root: string, opts: { pidfile?: string; ignoreTerm?: boolean } = {}) =>
		fakeExecutable(
			root,
			"slow-engine",
			[
				'const fs = require("node:fs");',
				opts.pidfile
					? `fs.writeFileSync(${JSON.stringify(opts.pidfile)}, String(process.pid));`
					: "",
				opts.ignoreTerm ? 'process.on("SIGTERM", () => {});' : "",
				"setInterval(() => {}, 200);",
				"setTimeout(() => process.exit(0), 20000);",
				"",
			].join("\n"),
		);

	test("one deadline covers narration", async () => {
		const root = tempDir("vdeck-deadline-");
		process.env.EIGHT_SUPERTONIC_BIN = slowEngine(root);
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		const t0 = Date.now();
		await expect(
			renderVideoDeck({
				spec: { slides: [{ title: "t", narration: "hello" }] },
				out: join(root, "o.mp4"),
				cwd: root,
				deadlineMs: 700,
			}),
		).rejects.toThrow(/deadline/);
		expect(Date.now() - t0).toBeLessThan(4000);
	});

	test("the deadline kills the narration engine (TERM, then KILL for one that ignores TERM)", async () => {
		const root = tempDir("vdeck-kill-");
		const pidfile = join(root, "pid");
		// On Windows a "SIGTERM" is TerminateProcess, so the engine cannot ignore it;
		// the deadline still ends it and the pid is gone, which is what is asserted.
		process.env.EIGHT_SUPERTONIC_BIN = slowEngine(root, { pidfile, ignoreTerm: true });
		process.env.EIGHT_KITTEN_PY = "/nonexistent";
		await expect(
			renderVideoDeck({
				spec: { slides: [{ title: "t", narration: "hello" }] },
				out: join(root, "o.mp4"),
				cwd: root,
				deadlineMs: 700,
			}),
		).rejects.toThrow(/deadline/);
		const pid = Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10);
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
		expect(alive()).toBe(false);
	});

	test("relative PATH entries never win and a binary inside the workspace is refused", () => {
		const base = tempDir("vdeck-bin-");
		const work = join(base, "work");
		mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
		const fake = join(work, "node_modules", ".bin", "ffmpeg");
		writeFileSync(fake, "#!/bin/sh\n");
		chmodSync(fake, 0o755);
		// relative entry is skipped entirely
		expect(() => resolveBinary("ffmpeg", work, undefined, "node_modules/.bin")).toThrow(
			/not found/,
		);
		expect(() => resolveBinary("ffmpeg", work, undefined, ".")).toThrow(/not found/);
		// absolute entry inside the workspace is refused
		expect(() =>
			resolveBinary("ffmpeg", work, undefined, join(work, "node_modules", ".bin")),
		).toThrow(/inside the working directory/);
		// symlink out of a clean dir into the workspace is refused too
		mkdirSync(join(base, "clean"));
		symlinkSync(fake, join(base, "clean", "ffmpeg"));
		expect(() => resolveBinary("ffmpeg", work, undefined, join(base, "clean"))).toThrow(
			/inside the working directory/,
		);
		// an override must be absolute
		expect(() => resolveBinary("ffmpeg", work, "ffmpeg")).toThrow(/absolute/);
		if (hasFfmpeg) expect(resolveBinary("ffmpeg", work)).toMatch(/^\//);
	});
});

describe("house film look (#4263)", () => {
	test("the entrance ends exactly on the settled slide", () => {
		expect(phase(0, 0.2, 0.6)).toBe(0);
		expect(phase(0.6, 0.2, 0.6)).toBe(1);
		expect(phase(1, 0.2, 0.6)).toBe(1);
		let prev = 0;
		for (let t = 0; t <= 1; t += 0.05) {
			const v = phase(t, 0.2, 0.6);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
	});

	test("t=1 paints the same bytes as the held still; early entrance frames differ", async () => {
		const root = tempDir("vdeck-film-");
		const slide = {
			title: "How to borrow",
			bullets: ["Card at the desk", "Proof of address"],
			narration: "Get a card.",
		};
		const held = await paintSlide(slide, "1280x720", root, "Tide Library", { index: 2, count: 5 });
		const settled = await paintSlide(slide, "1280x720", root, "Tide Library", {
			index: 2,
			count: 5,
			t: 1,
		});
		const start = await paintSlide(slide, "1280x720", root, "Tide Library", {
			index: 2,
			count: 5,
			t: 0,
		});
		const mid = await paintSlide(slide, "1280x720", root, "Tide Library", {
			index: 2,
			count: 5,
			t: 0.4,
		});
		expect(sha(settled)).toBe(sha(held));
		expect(new Set([sha(start), sha(mid), sha(held)]).size).toBe(3);
	});

	test("the counter and the caption are part of the picture", async () => {
		const root = tempDir("vdeck-film-cap-");
		const slide = { title: "What it is", bullets: ["Tools to borrow"] };
		const plain = await paintSlide(slide, "1280x720", root, undefined, { index: 0, count: 5 });
		const second = await paintSlide(slide, "1280x720", root, undefined, { index: 1, count: 5 });
		const captioned = await paintSlide(
			{ ...slide, narration: "Borrow it, don't buy it." },
			"1280x720",
			root,
			undefined,
			{ index: 0, count: 5 },
		);
		expect(sha(second)).not.toBe(sha(plain));
		expect(sha(captioned)).not.toBe(sha(plain));
	});

	test("a slide with an entrance gets a file-only image sequence before its still, and holds in whole frames", () => {
		const args = buildFfmpegArgs(
			[
				{
					png: "/w/s0.png",
					sec: 2,
					wav: "/w/a.wav",
					intro: { pattern: "/w/s0-in-%03d.png", count: 12 },
				},
				{ png: "/w/s1.png", sec: 1 },
			],
			"/w/o.mp4",
			true,
		);
		const inputs = args.reduce<number[]>((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
		expect(inputs.map((i) => args[i + 1])).toEqual([
			"/w/s0-in-%03d.png",
			"/w/s0.png",
			"/w/s1.png",
			"/w/a.wav",
		]);
		for (const i of inputs) expect(args.slice(i - 8, i)).toContain("-protocol_whitelist");
		// 2 s = 48 frames; 12 are the entrance, so the still holds 36 frames.
		const holdT = args[inputs[1] - 1];
		expect(holdT).toBe((36 / FPS).toFixed(3));
		const graph = args[args.indexOf("-filter_complex") + 1];
		expect(graph).toContain("[0:v]format=yuv420p,setsar=1,fps=24[e0]");
		expect(graph).toContain("[1:v]format=yuv420p,setsar=1,fps=24[h0]");
		expect(graph).toContain("[e0][h0]concat=n=2:v=1:a=0[v0]");
		expect(graph).toContain("[2:v]format=yuv420p,setsar=1,fps=24[v1]");
		expect(graph).toContain("[3:a]aresample=48000");
		expect(args.join(" ")).not.toMatch(/https?:|ftp:|tcp:|rtmp/);
	});

	test("without an entrance the argv is what it was before the film look", () => {
		const args = buildFfmpegArgs([{ png: "/w/a.png", sec: 1 }], "/w/o.mp4", false);
		expect(args.slice(5, 15)).toEqual([
			"-protocol_whitelist",
			"file",
			"-loop",
			"1",
			"-framerate",
			"24",
			"-t",
			"1.000",
			"-i",
			"/w/a.png",
		]);
		expect(args[args.indexOf("-filter_complex") + 1]).toBe(
			"[0:v]format=yuv420p,setsar=1,fps=24[v0];[v0]concat=n=1:v=1:a=0[v]",
		);
	});

	ffTest("each slide settles within the entrance, then holds one still to its end", async () => {
		const root = tempDir("vdeck-film-hold-");
		const r = await renderVideoDeck({ spec: SPEC, out: join(root, "f.mp4"), cwd: root });
		expect(r.slides).toBe(2);
		// Measured the way a still counter sees it: 160x90 grey, mean absolute difference per pixel
		// (x264 P-frames of one still differ by noise, so exact frame hashes are not the test).
		const raw = spawnSync("ffmpeg", [
			"-v",
			"error",
			"-i",
			join(root, "f.mp4"),
			"-vf",
			"scale=160:90,format=gray",
			"-f",
			"rawvideo",
			"-",
		]).stdout;
		const F = 160 * 90;
		expect(raw.length / F).toBe(48);
		const diff = (i: number, j: number) => {
			let d = 0;
			for (let k = 0; k < F; k++) d += Math.abs(raw[i * F + k] - raw[j * F + k]);
			return d / F;
		};
		for (const s of [0, 24]) {
			const moves = Array.from({ length: INTRO_FRAMES - 1 }, (_, i) => diff(s + i, s + i + 1));
			expect(Math.max(...moves)).toBeGreaterThan(0.1);
			for (let f = s + INTRO_FRAMES; f < s + 23; f++) expect(diff(f, f + 1)).toBeLessThan(0.05);
		}
		expect(diff(INTRO_FRAMES + 5, 24 + INTRO_FRAMES + 5)).toBeGreaterThan(2);
	});
});

describe("chapters and true duration (#4389)", () => {
	test("clock floors to m:ss and chapter lines are 'm:ss Title' from slide starts", () => {
		expect(clock(0)).toBe("0:00");
		expect(clock(59.49)).toBe("0:59");
		expect(clock(59.5)).toBe("1:00");
		expect(clock(65)).toBe("1:05");
		const slides = [{ title: "Intro" }, { text: "Body  text" }, { image: "a.png" }];
		expect(chapterLines(slides, [0, 3.5, 70])).toEqual([
			"0:00 Intro",
			"0:04 Body text",
			"1:10 Slide 3",
		]);
	});

	ffTest("a render writes chapters.txt whose starts match the slide durations", async () => {
		const root = tempDir("vdeck-chapters-");
		const spec = {
			slides: [
				{ title: "One", seconds: 2 },
				{ title: "Two", seconds: 3 },
				{ title: "Three", seconds: 1 },
			],
		};
		const r = await renderVideoDeck({ spec, out: join(root, "video", "b.mp4"), cwd: root });
		expect(r.starts).toEqual([0, 2, 5]);
		expect(r.chaptersPath).toBe(join(root, "video", "chapters.txt"));
		const file = readFileSync(r.chaptersPath, "utf8");
		expect(file).toBe("0:00 One\n0:02 Two\n0:05 Three\n");
		for (const line of file.trim().split("\n")) expect(line).toMatch(/^\d+:\d{2} \S/);
		expect(r.chapters).toEqual(file.trim().split("\n"));
		const real = Number(JSON.parse(probe(join(root, "video", "b.mp4"))).format.duration);
		expect(r.durationSec).toBeCloseTo(real, 2);
		expect(r.durationSec).toBeCloseTo(6, 1);
		expect(r.durationLabel).toBe("0:06");
	});

	test("a rounded start never lands past its own slide", () => {
		const slides = [{ title: "A" }, { title: "B" }, { title: "C" }];
		// slides last >= 1 s, so round(start) <= start + 0.5 <= end
		const starts = [0, 2.6, 3.6];
		const lines = chapterLines(slides, starts);
		expect(lines[0]).toBe("0:00 A");
		lines.forEach((l, i) => {
			const [m, sec] = l.split(" ")[0].split(":").map(Number);
			if (i + 1 < starts.length) expect(m * 60 + sec).toBeLessThanOrEqual(starts[i + 1]);
		});
	});

	ffTest(
		"a symlink or a directory named chapters.txt is refused before anything is written",
		async () => {
			const spec = { slides: [{ title: "One", seconds: 1 }] };
			const link = tempDir("vdeck-chlink-");
			const victim = join(link, "victim.txt");
			writeFileSync(victim, "keep");
			mkdirSync(join(link, "video"));
			symlinkSync(victim, join(link, "video", "chapters.txt"));
			await expect(
				renderVideoDeck({ spec, out: join(link, "video", "b.mp4"), cwd: link }),
			).rejects.toThrow(/symlink/);
			expect(existsSync(join(link, "video", "b.mp4"))).toBe(false);
			expect(readFileSync(victim, "utf8")).toBe("keep");

			const dir = tempDir("vdeck-chdir-");
			mkdirSync(join(dir, "video", "chapters.txt"), { recursive: true });
			await expect(
				renderVideoDeck({ spec, out: join(dir, "video", "b.mp4"), cwd: dir }),
			).rejects.toThrow(/directory/);
			expect(existsSync(join(dir, "video", "b.mp4"))).toBe(false);
		},
	);

	test("chapters.txt is confined like the mp4: same folder, never outside the working directory", async () => {
		const root = tempDir("vdeck-chscope-");
		mkdirSync(join(root, "video"));
		const { resolveDeckChapters } = await import("../../eight/tools");
		expect(resolveDeckChapters(join(root, "video", "b.mp4"), root)).toBe(
			join(root, "video", "chapters.txt"),
		);
		expect(() => resolveDeckChapters(join(root, "..", "x", "b.mp4"), root)).toThrow();
	});

	test("both tool surfaces carry the one complete description", async () => {
		const d = RENDER_VIDEO_DECK_DESCRIPTION;
		expect(d.split(/(?<=\.)\s/)[0]).toBe(
			"Slides + narration to MP4 from args {spec:{size, slides:[{title, bullets, narration}]}, out:'deck.mp4'}.",
		);
		expect(d).toContain("returns { path, durationSec, durationLabel, starts, chapters }");
		expect(d).toContain("overwrites it");
		expect(d).toContain("PREFER THIS");
		expect(d).toContain("spec = { title?, size?");
		expect(d).not.toContain("joins them and spec");
		const eight = new ToolExecutor(tempDir("vdeck-desc-")).getToolDefinitions() as {
			function: { name: string; description: string };
		}[];
		const e = eight.find((t) => t.function.name === "render_video_deck");
		expect(e?.function.description).toBe(`[MEDIA] ${d}`);
		const ai = (agentTools as unknown as Record<string, { description?: string }>)
			.render_video_deck;
		expect(ai.description).toBe(`[MEDIA] ${d}`);
	});
});
