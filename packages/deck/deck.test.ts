import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type NeuralDeps,
	NeuralTtsError,
	type SpawnResult,
	defaultDeps,
	findKittenPython,
	findSupertonic,
} from "../voice/neural";
import { deckVideoAfterWrite, deckVideoEnabled, shouldRenderDeckVideo } from "./auto";
import { renderMarkdown, slideHtml } from "./html";
import { isMarpDeck, parseDeck, plainInline, slideNarration } from "./parse";
import {
	MIN_SLIDE_SECONDS,
	checkNeuralEngines,
	concatArgs,
	concatListLine,
	findChrome,
	narrateSlides,
	renderDeckVideo,
	resolveDeckVoice,
	segmentArgs,
	slideSeconds,
} from "./render";

const FIXTURE = join(import.meta.dir, "fixtures", "deck.md");
const fixture = readFileSync(FIXTURE, "utf-8");

describe("isMarpDeck", () => {
	test("needs marp: true in front matter", () => {
		expect(isMarpDeck("---\nmarp: true\n---\n# A")).toBe(true);
		expect(isMarpDeck("---\ntheme: x\nmarp:  true  \n---\n# A")).toBe(true);
		expect(isMarpDeck("---\nmarp: false\n---\n# A")).toBe(false);
		expect(isMarpDeck("# A\n\nmarp: true\n")).toBe(false);
		expect(isMarpDeck("---\ntitle: x\n---\n# A")).toBe(false);
	});
});

describe("isMarpDeck without marp: true", () => {
	// Rishi pilot run 2026-09-29_221042: qwen wrote theme/paginate but no marp key.
	const pilotDeck =
		"---\ntheme: default\ntitle: Eight System One\npaginate: true\n---\n\n# One\n\n---\n\n# Two\n\n---\n\n# Three\n";
	test("Marp-only directives plus slide breaks count as a deck", () => {
		expect(isMarpDeck(pilotDeck)).toBe(true);
	});
	test("an explicit marp: false still opts out", () => {
		expect(isMarpDeck(pilotDeck.replace("paginate: true", "paginate: true\nmarp: false"))).toBe(
			false,
		);
	});
	test("a blog post with only title/author is not a deck, even with rules", () => {
		expect(isMarpDeck("---\ntitle: Post\nauthor: me\n---\n\n# A\n\n---\n\n# B\n")).toBe(false);
	});
	test("a Marp directive on a single-slide file is not enough", () => {
		expect(isMarpDeck("---\ntheme: default\n---\n\n# Only one\n")).toBe(false);
	});
});

describe("parseDeck", () => {
	test("strips front matter and splits the fixture into three slides", () => {
		const deck = parseDeck(fixture);
		expect(deck.frontMatter).toContain("marp: true");
		expect(deck.slides.map((s) => s.index)).toEqual([1, 2, 3]);
		expect(deck.slides[0].markdown.startsWith("# Eight System One")).toBe(true);
		expect(deck.slides[1].markdown.startsWith("# The Contract")).toBe(true);
	});

	test("a --- inside a code fence does not split the slide", () => {
		const md = "---\nmarp: true\n---\n\n# One\n\n```yaml\n---\nkey: v\n---\n```\n\n---\n\n# Two\n";
		const deck = parseDeck(md);
		expect(deck.slides).toHaveLength(2);
		expect(deck.slides[0].markdown).toContain("key: v");
		expect(deck.slides[1].markdown).toBe("# Two");
	});

	test("tilde fences are respected too", () => {
		const deck = parseDeck("# A\n\n~~~\n---\n~~~\n\n---\n\n# B");
		expect(deck.slides).toHaveLength(2);
	});

	test("--- directly under paragraph text is a setext heading, not a break", () => {
		const deck = parseDeck("# A\n\nSubtitle\n---\n\nbody\n\n---\n\n# B");
		expect(deck.slides).toHaveLength(2);
		expect(deck.slides[0].markdown).toContain("Subtitle\n---");
	});

	test("empty slides are dropped and CRLF is normalised", () => {
		const deck = parseDeck("---\r\nmarp: true\r\n---\r\n# A\r\n---\r\n\r\n---\r\n# B\r\n");
		expect(deck.slides.map((s) => s.markdown)).toEqual(["# A", "# B"]);
	});

	test("directive comments are dropped; other comments become notes", () => {
		const deck = parseDeck(fixture);
		const guard = deck.slides[2];
		expect(guard.markdown).not.toContain("<!--");
		expect(guard.markdown).not.toContain("_class");
		expect(guard.notes).toEqual([
			"Speaker note: rules only make verdicts stricter; pass means ask the model.",
		]);
		expect(deck.slides[0].notes).toEqual([]);
	});
});

describe("narration", () => {
	test("plainInline strips markdown but keeps code identifiers intact", () => {
		expect(plainInline("**Bold** and *it* and `EIGHT_SYSTEM_ONE=1` [link](http://x)")).toBe(
			"Bold and it and EIGHT_SYSTEM_ONE=1 link",
		);
		expect(plainInline("a \u2192 b, 2\u2013255")).toBe("a to b, 2 to 255");
	});

	test("reads headings, bullets, table rows, and replaces code blocks", () => {
		const deck = parseDeck(fixture);
		expect(slideNarration(deck.slides[0])).toBe(
			"Eight System One. A Local Decision Engine. @8gent/decide - typed questions, calibrated probabilities. Code owns thresholds; backends report probability mass only. Three question kinds: noul, choice, score.",
		);
		expect(slideNarration(deck.slides[1])).toBe(
			"The Contract. noul: Input prompt; Output { yes }, confidence. choice: Input prompt, options[] (2-255); Output probabilities[], chosen. Code example.",
		);
	});

	test("speaker notes win over the slide body", () => {
		const deck = parseDeck(fixture);
		expect(slideNarration(deck.slides[2])).toBe(
			"Speaker note: rules only make verdicts stricter; pass means ask the model.",
		);
	});

	test("same input, same narration", () => {
		const a = parseDeck(fixture).slides.map(slideNarration);
		const b = parseDeck(fixture).slides.map(slideNarration);
		expect(a).toEqual(b);
	});
});

describe("html", () => {
	test("renders tables, code, and escapes html", () => {
		const html = renderMarkdown("| a | b |\n|---|--:|\n| `x` | <y> |\n\n```ts\nif (a < b) {}\n```");
		expect(html).toContain("<table>");
		expect(html).toContain('<td style="text-align:right">&lt;y&gt;</td>');
		expect(html).toContain("<code>x</code>");
		expect(html).toContain('<pre data-lang="ts"><code>if (a &lt; b) {}</code></pre>');
	});

	test("the slide page is 1920x1080 and uses no banned purple or pink hues", () => {
		const page = slideHtml(parseDeck(fixture).slides[0], 3);
		expect(page).toContain("width:1920px;height:1080px");
		expect(page).toContain("1 / 3");
		for (const hex of page.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) {
			const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max === min) continue;
			const d = max - min;
			let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
			h = (h * 60 + 360) % 360;
			expect(h >= 270 && h <= 350).toBe(false);
		}
	});
});

describe("ffmpeg args", () => {
	test("segment holds the still for the given seconds with H.264 and AAC", () => {
		const args = segmentArgs("/w/slide-001.png", "/w/slide-001.aiff", 4.2, "/w/slide-001.mp4");
		expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "4.200"]);
		expect(args).toContain("libx264");
		expect(args).toContain("aac");
		expect(args[args.indexOf("-loop") + 1]).toBe("1");
		expect(args.at(-1)).toBe("/w/slide-001.mp4");
		expect(segmentArgs("a", "b", 1, "c")).toEqual(segmentArgs("a", "b", 1, "c"));
	});

	test("concat copies streams from a list file", () => {
		const args = concatArgs("/w/segments.txt", "/out/deck.mp4");
		expect(args).toContain("concat");
		expect(args[args.indexOf("-c") + 1]).toBe("copy");
		expect(args.at(-1)).toBe("/out/deck.mp4");
		expect(concatListLine("/tmp/it's/a.mp4")).toBe("file '/tmp/it'\\''s/a.mp4'");
	});

	test("slide time is audio plus pad, never under the minimum", () => {
		expect(slideSeconds(0.1)).toBe(MIN_SLIDE_SECONDS);
		expect(slideSeconds(5)).toBe(5.6);
	});
});

describe("deck video default", () => {
	test("only Marp .md files render, and EIGHT_DECK_VIDEO=0 opts out", () => {
		expect(shouldRenderDeckVideo("deck/deck.md", fixture, {})).toBe(true);
		expect(shouldRenderDeckVideo("deck/deck.txt", fixture, {})).toBe(false);
		expect(shouldRenderDeckVideo("README.md", "# Hi", {})).toBe(false);
		expect(shouldRenderDeckVideo("deck/deck.md", fixture, { EIGHT_DECK_VIDEO: "0" })).toBe(false);
		expect(deckVideoEnabled({ EIGHT_DECK_VIDEO: "off" })).toBe(false);
		expect(deckVideoEnabled({ EIGHT_DECK_VIDEO: "1" })).toBe(true);
	});

	test("a render failure becomes a result line and never throws", async () => {
		const prev = process.env.EIGHT_DECK_VIDEO;
		Reflect.deleteProperty(process.env, "EIGHT_DECK_VIDEO");
		try {
			const line = await deckVideoAfterWrite("/w/deck/deck.md", fixture, "/w", async () => {
				throw new Error("no Chrome or Chromium found");
			});
			expect(line).toBe("deck video not rendered: no Chrome or Chromium found");
			const ok = await deckVideoAfterWrite("/w/deck/deck.md", fixture, "/w", async () => ({
				output: "/w/deck/deck.mp4",
				slides: 3,
				seconds: 31,
				voice: "Samantha",
			}));
			expect(ok).toBe("rendered deck/deck.mp4: 3 slides, 31s, voice Samantha");
			expect(await deckVideoAfterWrite("/w/a.md", "# not a deck", "/w")).toBe("");
		} finally {
			if (prev !== undefined) process.env.EIGHT_DECK_VIDEO = prev;
		}
	});
});

function commandExists(cmd: string): boolean {
	try {
		execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const canRender =
	commandExists("ffmpeg") &&
	commandExists("ffprobe") &&
	(findSupertonic(defaultDeps()) !== null || findKittenPython(defaultDeps()) !== null) &&
	findChrome() !== null;

describe.skipIf(!canRender)("renderDeckVideo (integration)", () => {
	test("renders the fixture to an MP4 with video and audio", async () => {
		const dir = mkdtempSync(join(tmpdir(), "8gent-deck-test-"));
		try {
			const deck = join(dir, "deck.md");
			copyFileSync(FIXTURE, deck);
			const result = await renderDeckVideo(deck);
			expect(result.output).toBe(join(dir, "deck.mp4"));
			expect(existsSync(result.output)).toBe(true);
			expect(result.slides).toBe(3);
			const probe = JSON.parse(
				execFileSync(
					"ffprobe",
					["-v", "error", "-show_streams", "-show_format", "-of", "json", result.output],
					{ encoding: "utf-8" },
				),
			);
			const types = probe.streams.map((s: { codec_type: string }) => s.codec_type);
			expect(types).toContain("video");
			expect(types).toContain("audio");
			const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
			expect(video.codec_name).toBe("h264");
			expect(video.width).toBe(1920);
			expect(video.height).toBe(1080);
			expect(Number(probe.format.duration)).toBeGreaterThan(result.slides * 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);
});

// ── Neural narration (#3346). Every spawn is faked; no engine is needed. ──

interface Call {
	cmd: string;
	args: string[];
	input?: string;
}

const ST = "/opt/homebrew/bin/supertonic";
const PY = "/opt/homebrew/bin/python3";

/** A fake machine: `files` is what exists, the flags say which engine works. */
function fakeNeural(opts: {
	files?: string[];
	supertonicWorks?: boolean;
	kittenWorks?: boolean;
}): NeuralDeps & { calls: Call[] } {
	const files = new Set(opts.files ?? []);
	const calls: Call[] = [];
	return {
		calls,
		env: {},
		home: "/home/fake",
		exists: (p) => files.has(p),
		fileSize: (p) => (files.has(p) ? 1 : 0),
		remove: (p) => {
			files.delete(p);
		},
		realpath: (p) => p,
		makeTempDir: () => "/tmp/neural-fake",
		removeTree: () => {},
		which: (cmd) =>
			cmd === "supertonic" && files.has(ST) ? ST : cmd === "python3" && files.has(PY) ? PY : null,
		listDir: () => [],
		spawn: async (cmd, args, o): Promise<SpawnResult> => {
			calls.push({ cmd, args, input: o.input });
			if (basename(cmd) === "supertonic") {
				if (!opts.supertonicWorks) return { status: 1, stderr: "model load failed" };
				files.add(args[args.indexOf("-o") + 1]);
				return { status: 0, stderr: "" };
			}
			// The -P capability probe, then the Kitten batch script.
			if (args.at(-1) === "pass") return { status: 0, stderr: "" };
			if (!opts.kittenWorks) return { status: 1, stderr: "No module named kittentts" };
			const job = JSON.parse(o.input ?? "{}") as { items: { out: string }[] };
			for (const it of job.items) files.add(it.out);
			return { status: 0, stderr: "" };
		},
	};
}

/** The calls that ran the Kitten batch script (not the -P probe). */
const kittenRuns = (calls: Call[]) =>
	calls.filter((c) => basename(c.cmd) !== "supertonic" && c.args.at(-1) !== "pass");

const slides = parseDeck(fixture).slides;

describe("deck voice casting", () => {
	test("default is the narrator; codes and first names resolve to the table name", () => {
		expect(resolveDeckVoice(undefined, {})).toBe("Daniel");
		expect(resolveDeckVoice("8TO", {})).toBe("Rishi");
		expect(resolveDeckVoice("luis", {})).toBe("Fred");
		expect(resolveDeckVoice(undefined, { EIGHT_DECK_VOICE: "Moira" })).toBe("Moira");
		expect(resolveDeckVoice("Karen", { EIGHT_DECK_VOICE: "Moira" })).toBe("Karen");
	});

	test("an unpinned voice (a system voice name) fails instead of falling back", () => {
		for (const name of ["Good News", "Zarvox"]) {
			let err: unknown;
			try {
				resolveDeckVoice(name, {});
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(NeuralTtsError);
			expect((err as NeuralTtsError).code).toBe("unpinned_voice");
		}
	});

	test("the preflight needs the voice's pinned engine; the other engine does not count", () => {
		expect(() => checkNeuralEngines(fakeNeural({}))).toThrow(NeuralTtsError);
		// Daniel (the default) and Rishi are Supertonic; Fred (8CO) is Kitten.
		expect(() => checkNeuralEngines(fakeNeural({ files: [ST] }))).not.toThrow();
		expect(() => checkNeuralEngines(fakeNeural({ files: [ST] }), "Rishi")).not.toThrow();
		expect(() => checkNeuralEngines(fakeNeural({ files: [PY] }), "Fred")).not.toThrow();
		expect(() => checkNeuralEngines(fakeNeural({ files: [PY] }), "Rishi")).toThrow(
			/pinned to supertonic M3/,
		);
		expect(() => checkNeuralEngines(fakeNeural({ files: [ST] }), "Fred")).toThrow(
			/pinned to kitten Bruno/,
		);
	});
});

describe("narrateSlides", () => {
	test("a Supertonic voice gets one spawn per slide with its pinned style", async () => {
		const deps = fakeNeural({ files: [ST, PY], supertonicWorks: true });
		const wavs = await narrateSlides(slides, "Rishi", "/w", deps);
		expect(wavs).toEqual(["/w/slide-001.wav", "/w/slide-002.wav", "/w/slide-003.wav"]);
		expect(deps.calls.length).toBe(3);
		for (const c of deps.calls) {
			expect(c.cmd).toBe(ST);
			expect(c.args[c.args.indexOf("--voice") + 1]).toBe("M3");
		}
	});

	test("a KittenTTS voice voices every slide in one python process", async () => {
		const deps = fakeNeural({ files: [ST, PY], kittenWorks: true });
		const wavs = await narrateSlides(slides, "Fred", "/w", deps);
		expect(wavs.length).toBe(3);
		const runs = kittenRuns(deps.calls);
		expect(runs.length).toBe(1);
		const job = JSON.parse(runs[0].input ?? "{}") as {
			items: { voice: string; text: string }[];
		};
		expect(job.items.map((i) => i.voice)).toEqual(["Bruno", "Bruno", "Bruno"]);
		expect(job.items[0].text.length).toBeGreaterThan(0);
	});

	test("a failed pinned engine fails the deck: the other engine's voice never stands in", async () => {
		const deps = fakeNeural({ files: [ST, PY], supertonicWorks: false, kittenWorks: true });
		await expect(narrateSlides(slides, "Rishi", "/w", deps)).rejects.toThrow(
			/engine_failed|fallback is off/,
		);
		expect(kittenRuns(deps.calls)).toEqual([]);
	});

	test("a failed pinned engine fails the render, naming the slide and the attempt", async () => {
		const deps = fakeNeural({ files: [ST, PY] });
		let err: unknown;
		try {
			await narrateSlides(slides, "Rishi", "/w", deps);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(NeuralTtsError);
		const e = err as NeuralTtsError;
		expect(e.code).toBe("engine_failed");
		expect(e.message).toContain("slide 1");
		expect(e.message).toContain("model load failed");
		expect(e.attempts.length).toBe(1);
	});
});

describe("renderDeckVideo neural preflight", () => {
	test("an unpinned voice rejects before anything is spawned", async () => {
		const deps = fakeNeural({ files: [ST, PY], supertonicWorks: true });
		await expect(renderDeckVideo(FIXTURE, { voice: "Zarvox", neural: deps })).rejects.toThrow(
			/not in NEURAL_VOICE/,
		);
		expect(deps.calls).toEqual([]);
	});

	test("no engine rejects with no_engine before Chrome or ffmpeg", async () => {
		const deps = fakeNeural({});
		await expect(
			renderDeckVideo(FIXTURE, { neural: deps, chrome: "/nonexistent/chrome" }),
		).rejects.toThrow(/no neural TTS engine found/);
		expect(deps.calls).toEqual([]);
	});
});

describe("macOS say is unreachable from the deck renderer", () => {
	test("no narration scenario ever spawns say", async () => {
		for (const [st, kt] of [
			[true, true],
			[false, true],
			[true, false],
			[false, false],
		]) {
			const deps = fakeNeural({
				files: [ST, PY, "/usr/bin/say"],
				supertonicWorks: st,
				kittenWorks: kt,
			});
			try {
				await narrateSlides(slides, "Daniel", "/w", deps);
			} catch {
				// Failure is expected in the both-fail case.
			}
			for (const c of deps.calls) expect(basename(c.cmd)).not.toBe("say");
		}
	});

	test("render.ts source has no say code path", () => {
		const src = readFileSync(join(import.meta.dir, "render.ts"), "utf8");
		expect(src).not.toMatch(/\bsay\b/);
		expect(src).not.toMatch(/aiff|voice-resolver|afplay|AVSpeech|NSSpeech/i);
		expect(src).toContain("synthesizeBatch(");
	});
});
