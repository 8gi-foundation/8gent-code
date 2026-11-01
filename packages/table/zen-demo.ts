/**
 * Zen-gen end-to-end demo (spec section 6).
 *
 *   bun run packages/table/zen-demo.ts <dictation.wav> [--topic "..."]
 *
 * James dictates. Whisper transcribes locally. Beats are segmented by pure
 * rules. Slides are chosen by pure rules. His ORIGINAL recording is the
 * playback audio - never re-synthesised, because it is his voice and not a
 * clone of it. Each slide is shown across exactly the window whisper reports
 * for the words it was built from, so sync is exact by construction.
 *
 * ZERO LLM tokens. Zero network bytes. The only model is whisper.cpp's
 * ggml-base.en (74M params, on-device ASR, no context window, not billed).
 *
 * With no wav argument, the demo synthesises a stand-in recording with
 * Supertonic so the pipeline can be exercised on a machine with no microphone
 * capture wired yet. That stand-in is clearly labelled in the output; it is a
 * test of the PIPELINE, and the real path takes James's own microphone audio.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bakeHuddle, ensureHuddleDirs, THEME_VERSION, type BakedTurn, type HuddleManifest } from "./bake";
import { findSupertonic, probeDurationMs } from "./huddle-voice";
import { renderSlide } from "./slide-render";
import { parseWhisperJson, zenSlides } from "./zen";
import { OFFICERS } from "./officers";

const WHISPER_MODEL = join(homedir(), ".8gent", "models", "whisper", "ggml-base.en.bin");
const HUDDLE_ID = `huddle_zen_${Date.now().toString(36)}`;

const topicIdx = process.argv.indexOf("--topic");
const TOPIC = topicIdx > -1 ? process.argv[topicIdx + 1] : "Zen gen dictation";

/** A stand-in recording, used only when no real dictation wav was supplied. */
const STAND_IN = [
	"So here is where the huddle stage actually stands today.",
	"The floor protocol is on main and it holds the turn order.",
	"Now the new part. Officers write a slide spec instead of prose,",
	"and code renders it, so a slide costs about 40 tokens.",
	"Next, every number on a slide comes from a resolved claim,",
	"never from the model, and anything unverified is marked on screen.",
	"Finally the whole huddle bakes down to one MP4 you can watch from your phone.",
].join(" ");

function synthesiseStandIn(outPath: string): boolean {
	const bin = findSupertonic();
	if (!bin) return false;
	const r = spawnSync(bin, ["tts", STAND_IN, "-o", outPath, "--voice", "M4", "--steps", "8"], {
		encoding: "utf8",
		timeout: 180_000,
	});
	return r.status === 0 && existsSync(outPath);
}

function transcribe(wavPath: string): string | null {
	if (!existsSync(WHISPER_MODEL)) {
		console.error(`no whisper model at ${WHISPER_MODEL}`);
		return null;
	}
	// -oj writes <wav>.json next to the input. -ml 90 keeps segments short
	// enough that beat rules have something to work with. Fully local.
	const r = spawnSync(
		"whisper-cli",
		["-m", WHISPER_MODEL, "-f", wavPath, "-oj", "-ml", "90", "-sow", "-l", "en", "-nt"],
		{ encoding: "utf8", timeout: 600_000 },
	);
	const jsonPath = `${wavPath}.json`;
	if (r.status !== 0 || !existsSync(jsonPath)) {
		console.error(`whisper failed: ${r.stderr?.slice(0, 300)}`);
		return null;
	}
	return jsonPath;
}

function main(): void {
	const dir = ensureHuddleDirs(HUDDLE_ID);
	let wavPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
	let standIn = false;

	if (!wavPath) {
		wavPath = join(dir, "audio", "zen-0.wav");
		console.log("No dictation wav supplied. Synthesising a STAND-IN recording to exercise the pipeline.");
		console.log("The real path uses James's own microphone audio, which is never re-synthesised.\n");
		if (!synthesiseStandIn(wavPath)) {
			console.error("Could not synthesise a stand-in (no Supertonic). Supply a wav path instead.");
			process.exit(1);
		}
		standIn = true;
	}
	if (!existsSync(wavPath)) {
		console.error(`no such wav: ${wavPath}`);
		process.exit(1);
	}

	const audioMs = probeDurationMs(wavPath) ?? 0;
	console.log(`dictation: ${wavPath} (${(audioMs / 1000).toFixed(1)}s)${standIn ? " [STAND-IN]" : ""}`);

	const t0 = Date.now();
	const jsonPath = transcribe(wavPath);
	if (!jsonPath) process.exit(1);
	const sttMs = Date.now() - t0;

	const segments = parseWhisperJson(readFileSync(jsonPath, "utf8"));
	const slides = zenSlides(segments, Object.keys(OFFICERS));
	console.log(`whisper: ${segments.length} segments in ${(sttMs / 1000).toFixed(1)}s (${(sttMs / audioMs).toFixed(2)}x realtime)`);
	console.log(`beats:   ${slides.length} slides, ZERO LLM tokens\n`);

	const turns: BakedTurn[] = slides.map((slide, i) => {
		const ctx = { code: "HUMAN", name: "James", index: i + 1, total: slides.length, huddleId: HUDDLE_ID };
		const { html, sha256 } = renderSlide(slide.spec, ctx);
		const turnId = `zen-${String(i).padStart(2, "0")}`;
		writeFileSync(join(dir, "slides", `slide-${turnId}.html`), html, "utf8");
		console.log(
			`  ${String(i + 1).padStart(2)}. ${(slide.t0 / 1000).toFixed(1)}s-${(slide.t1 / 1000).toFixed(1)}s  ` +
				`${slide.spec.layout.padEnd(8)} ${slide.spec.heading}`,
		);
		return {
			turnId,
			index: i,
			holder: "human:james",
			code: "HUMAN",
			name: "James",
			voice: "dictated",
			spec: slide.spec,
			sha256,
			text: slide.text,
			// His ORIGINAL recording, sliced by whisper's own timestamps.
			audioPath: wavPath,
			audioOffsetMs: slide.t0,
			durationMs: slide.t1 - slide.t0,
			hasAsserted: false,
			assertedFields: [],
		};
	});

	if (turns.length === 0) {
		console.error("\nNo beats produced - nothing to bake.");
		process.exit(1);
	}

	const manifest: HuddleManifest = {
		huddleId: HUDDLE_ID,
		channelId: "zen",
		topic: TOPIC,
		themeVersion: THEME_VERSION,
		openedAt: t0,
		closedAt: Date.now(),
		turns,
	};

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
	const result = bakeHuddle(manifest, stamp);
	console.log(`\n  transcript: ${result.transcriptPath}`);
	if (result.videoPath) console.log(`  VIDEO: ${result.videoPath}`);
	else console.error(`  VIDEO FAILED: ${result.videoError}`);
	process.exit(result.videoPath ? 0 : 1);
}

main();
