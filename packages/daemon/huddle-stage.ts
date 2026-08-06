/**
 * 8gent Huddle Phase 1 - the daemon side of the stage (spec sections 5, 7, 8).
 *
 * Phase 0 gave the floor: who speaks, in what order, for how long. This module
 * gives the floor a FACE and a VOICE, without introducing a second timeline.
 * Every visual event here is caused by a FloorMachine frame; nothing in this
 * file decides who speaks next, and nothing here can stall the floor.
 *
 * Per turn, in order (spec 5.1):
 *   parse the officer's [[SLIDE]]  ->  resolve its [[CLAIM]] references
 *   ->  render (pure, hashed)      ->  broadcast huddle:slide
 *   ->  WAIT for huddle:stage_ready for THAT turnId, capped at 3s
 *   ->  synthesise narration in the officer's DECLARED voice
 *   ->  broadcast huddle:speak
 *
 * The wait is the gate that makes "voice never starts before its slide is on
 * screen" true rather than hoped for. The cap is what makes a headless huddle
 * (no stage connected) still produce a correct artifact instead of hanging.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bakeHuddle,
	ensureHuddleDirs,
	huddleDir,
	THEME_VERSION,
	type BakedTurn,
	type HuddleManifest,
} from "../table/bake";
import { estimateReadingMs, narrateTurn, speechText, voiceFor } from "../table/huddle-voice";
import { OFFICERS } from "../table/officers";
import { renderSlide } from "../table/slide-render";
import { resolveSlide, type SlideSpec } from "../table/slide-spec";
import { verifySlideSpec } from "../table/slide-verify";
import { STAGE_READY_CAP_MS, stagePage } from "../table/stage";
import { parseWhisperJson, zenSlides } from "../table/zen";

/** Broadcast signature, matching table-routes.ts's ChannelBroadcast. */
type Broadcast = (channelId: string, frame: Record<string, unknown>) => void;

/** Per-huddle Phase 1 state. Deliberately parallel to huddle-routes.ts's own
 *  registry rather than merged into it, so Phase 0's floor logic stays free of
 *  any rendering concern. */
interface StageState {
	channelId: string;
	topic: string;
	turns: BakedTurn[];
	/** Resolvers for turns currently waiting on a stage_ready ack. */
	pendingReady: Map<string, () => void>;
	openedAt: number;
	/** True once a stage has ever acked. A huddle nobody is watching does not
	 *  wait the full cap on every subsequent turn. */
	stageSeen: boolean;
}

const stages = new Map<string, StageState>();

/**
 * MEDIA SWITCH: does this process actually synthesise audio and bake video?
 *
 * Slide rendering is pure and costs microseconds, so it always runs. Narration
 * (a Supertonic subprocess per turn) and the bake (a Chrome screenshot plus an
 * ffmpeg encode per slide) are heavyweight IO measured in seconds. Running them
 * implicitly turned Phase 0's termination fuzz test - which opens and closes
 * many randomised huddles - from milliseconds into a 33 second timeout.
 *
 * So heavy IO is opt-OUT under test and opt-IN nowhere else: a real daemon
 * bakes, a test run does not. This is a switch on side effects only. It never
 * changes the floor, the turn record, the slide, or its hash, so a huddle run
 * with media off produces exactly the same manifest as one run with it on,
 * minus the audio paths.
 */
let mediaEnabled = process.env.NODE_ENV !== "test";

/** Explicitly enable or disable narration and baking for this process. */
export function setHuddleMedia(enabled: boolean): void {
	mediaEnabled = enabled;
}

export function huddleMediaEnabled(): boolean {
	return mediaEnabled;
}

export function openStage(huddleId: string, channelId: string, topic: string): void {
	ensureHuddleDirs(huddleId);
	stages.set(huddleId, {
		channelId,
		topic,
		turns: [],
		pendingReady: new Map(),
		openedAt: Date.now(),
		stageSeen: false,
	});
}

export function stageIsOpen(huddleId: string): boolean {
	return stages.has(huddleId);
}

/** Called from the huddle:stage_ready frame handler. Releases the gate. */
export function noteStageReady(huddleId: string, turnId: string): void {
	const state = stages.get(huddleId);
	if (!state) return;
	state.stageSeen = true;
	const resolve = state.pendingReady.get(turnId);
	if (resolve) {
		state.pendingReady.delete(turnId);
		resolve();
	}
}

function waitForStage(state: StageState, huddleId: string, turnId: string): Promise<void> {
	// Nobody has ever acked on this huddle: assume headless and do not burn 3s
	// per turn waiting for a stage that is not there.
	if (!state.stageSeen) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			state.pendingReady.delete(turnId);
			resolve();
		}, STAGE_READY_CAP_MS);
		state.pendingReady.set(turnId, () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function codeOf(holder: string): string {
	return holder.startsWith("agent:") ? holder.slice("agent:".length).toUpperCase() : "HUMAN";
}

function nameOf(holder: string): string {
	if (holder.startsWith("human:")) {
		const raw = holder.slice("human:".length);
		return raw.charAt(0).toUpperCase() + raw.slice(1);
	}
	const code = codeOf(holder);
	return OFFICERS[code]?.name ?? code;
}

/** Absolute directories a slide's claim references may read. Same default the
 *  verify substrate uses; never widened by anything an officer writes. */
function claimRoots(): string[] {
	const home = process.env.HOME ?? "/";
	return [join(home, "8gent-code"), join(home, "8gi-governance"), join(home, ".8gent")];
}

export interface TurnPipelineResult {
	spec: SlideSpec;
	sha256: string;
	durationMs: number;
	audioPath: string | null;
}

/**
 * The whole Phase 1 turn pipeline. Called from FloorCallbacks.postTurnText, so
 * it runs AFTER the officer's text is known and the channel post has been made.
 *
 * Never throws: a rendering or TTS failure degrades the turn to "slide only" or
 * "text only" and is recorded, because losing the visual must never lose the
 * turn or stall the floor.
 */
export async function runTurnPipeline(
	huddleId: string,
	turnId: string,
	holder: string,
	replyText: string,
	broadcast: Broadcast,
	opts: { interactive?: boolean } = {},
): Promise<TurnPipelineResult | null> {
	const state = stages.get(huddleId);
	if (!state) return null;

	try {
		const code = codeOf(holder);
		const name = nameOf(holder);
		const index = state.turns.length;

		// 1. The officer's own spec, or a deterministic fallback from their prose.
		const resolved = resolveSlide(replyText);

		// 2. References become values. Code writes every number, never the model.
		const verified = verifySlideSpec(resolved.spec, { roots: claimRoots() });

		// 3. Pure render, hashed for provenance.
		const ctx = {
			code,
			name,
			index: index + 1,
			assertedFields: verified.assertedFields,
		};
		const { html, sha256 } = renderSlide(verified.spec, ctx);
		const dir = ensureHuddleDirs(huddleId);
		writeFileSync(join(dir, "slides", `slide-${turnId}.html`), html, "utf8");

		// 4. Show it, then WAIT for the stage to confirm it composited.
		broadcast(state.channelId, {
			type: "huddle:slide",
			huddleId,
			turnId,
			holder,
			name,
			code,
			html,
			sha256,
			layout: verified.spec.layout,
			asserted: verified.assertedFields,
		});
		await waitForStage(state, huddleId, turnId);

		// 5. Voice, in the officer's DECLARED voice. Never inferred.
		const voice = voiceFor(code);
		const wav = join(dir, "audio", `turn-${turnId}.wav`);
		const speech = speechText(resolved.speech);
		const narration = mediaEnabled
			? narrateTurn({ text: speech, voice, outPath: wav, interactive: opts.interactive ?? true })
			: // Media off: the turn still gets a correct, deterministic duration
				// from the reading estimate, so the manifest and the deck timings are
				// identical to a narrated run.
				{ audioPath: null, durationMs: estimateReadingMs(speech), skipped: "no_tts" as const };

		broadcast(state.channelId, {
			type: "huddle:speak",
			huddleId,
			turnId,
			voice: voice.supertonic,
			audioUrl: narration.audioPath ? `/huddle/${huddleId}/audio/turn-${turnId}.wav` : null,
			durationMs: narration.durationMs,
			skipped: narration.skipped ?? null,
		});

		state.turns.push({
			turnId,
			index,
			holder,
			code,
			name,
			voice: voice.supertonic,
			spec: verified.spec,
			sha256,
			text: resolved.speech,
			audioPath: narration.audioPath,
			audioOffsetMs: 0,
			durationMs: narration.durationMs,
			hasAsserted: verified.assertedFields.length > 0,
			assertedFields: verified.assertedFields,
		});

		return { spec: verified.spec, sha256, durationMs: narration.durationMs, audioPath: narration.audioPath };
	} catch (err) {
		console.warn(`[huddle] slide pipeline failed for turn ${turnId}: ${(err as Error).message}`);
		return null;
	}
}

// ── zen-gen: James takes the floor and dictates ───────────────────────────

/**
 * Ingest one dictation. His ORIGINAL wav is the playback audio - it is never
 * re-synthesised, because it is his voice and not a clone of it. Whisper's own
 * timestamps key each slide to that same audio, so sync is exact by
 * construction rather than estimated.
 *
 * Zero LLM tokens: whisper.cpp is an on-device ASR model, and every step after
 * it is a pure function (packages/table/zen.ts).
 */
export function ingestDictation(
	huddleId: string,
	holder: string,
	wavPath: string,
	whisperJsonPath: string,
	broadcast: Broadcast,
): number {
	const state = stages.get(huddleId);
	if (!state) return 0;
	if (!existsSync(whisperJsonPath)) return 0;

	const segments = parseWhisperJson(readFileSync(whisperJsonPath, "utf8"));
	const slides = zenSlides(segments, Object.keys(OFFICERS));
	const dir = ensureHuddleDirs(huddleId);
	const name = nameOf(holder);

	for (const slide of slides) {
		const turnId = `zen_${huddleId.slice(-6)}_${slide.index}`;
		const index = state.turns.length;
		const ctx = { code: "HUMAN", name, index: index + 1 };
		const { html, sha256 } = renderSlide(slide.spec, ctx);
		writeFileSync(join(dir, "slides", `slide-${turnId}.html`), html, "utf8");

		broadcast(state.channelId, {
			type: "huddle:slide",
			huddleId,
			turnId,
			holder,
			name,
			code: "HUMAN",
			html,
			sha256,
			layout: slide.spec.layout,
			asserted: [],
		});

		state.turns.push({
			turnId,
			index,
			holder,
			code: "HUMAN",
			name,
			// His own recording. The voice field records that fact rather than
			// naming a synthesis style that was never used.
			voice: "dictated",
			spec: slide.spec,
			sha256,
			text: slide.text,
			audioPath: wavPath,
			audioOffsetMs: slide.t0,
			durationMs: slide.t1 - slide.t0,
			hasAsserted: false,
			assertedFields: [],
		});
	}
	return slides.length;
}

// ── the bake, on close ────────────────────────────────────────────────────

export interface CloseResult {
	videoPath: string | null;
	videoError?: string;
	transcriptPath: string;
	turnCount: number;
	hashes: string[];
}

/** Bake the artifact and drop the stage state. Never throws. */
export function closeStage(huddleId: string): CloseResult | null {
	const state = stages.get(huddleId);
	if (!state) return null;
	stages.delete(huddleId);

	const manifest: HuddleManifest = {
		huddleId,
		channelId: state.channelId,
		topic: state.topic,
		themeVersion: THEME_VERSION,
		openedAt: state.openedAt,
		closedAt: Date.now(),
		turns: state.turns,
	};

	if (!mediaEnabled) {
		// Still write the manifest, transcript and decks - they are cheap, and a
		// huddle must always leave a readable record. Only the MP4 is skipped.
		writeFileSync(join(ensureHuddleDirs(huddleId), "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
		return {
			videoPath: null,
			videoError: "media disabled for this process",
			transcriptPath: join(huddleDir(huddleId), "transcript.md"),
			turnCount: state.turns.length,
			hashes: state.turns.map((t) => t.sha256),
		};
	}

	try {
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
		const result = bakeHuddle(manifest, stamp);
		return {
			videoPath: result.videoPath,
			videoError: result.videoError,
			transcriptPath: result.transcriptPath,
			turnCount: state.turns.length,
			hashes: state.turns.map((t) => t.sha256),
		};
	} catch (err) {
		return {
			videoPath: null,
			videoError: (err as Error).message,
			transcriptPath: join(huddleDir(huddleId), "transcript.md"),
			turnCount: state.turns.length,
			hashes: state.turns.map((t) => t.sha256),
		};
	}
}

// ── HTTP: the stage page and its assets ───────────────────────────────────

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".wav": "audio/wav", ".png": "image/png" };

/**
 * Serve GET /huddle/<id>/stage and /huddle/<id>/{slides,audio}/<file>.
 * Returns null when the path is not ours, so the gateway falls through.
 *
 * SECURITY: the only path segments accepted are a huddle id and a single
 * filename with no separators, resolved under that huddle's own directory. A
 * traversal attempt does not reach the filesystem.
 */
export function handleStageHttp(url: URL, wsUrl: string): Response | null {
	const m = /^\/huddle\/([A-Za-z0-9_]+)\/(stage|slides|audio)(?:\/([A-Za-z0-9._-]+))?$/.exec(url.pathname);
	if (!m) return null;
	const [, huddleId, kind, file] = m;

	if (kind === "stage") {
		const topic = stages.get(huddleId)?.topic ?? "";
		return new Response(stagePage({ huddleId, wsUrl, topic }), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}

	if (!file || file.includes("..")) return new Response("not found", { status: 404 });
	const path = join(huddleDir(huddleId), kind, file);
	if (!existsSync(path)) return new Response("not found", { status: 404 });
	const ext = file.slice(file.lastIndexOf("."));
	return new Response(readFileSync(path), {
		headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" },
	});
}

export { STAGE_READY_CAP_MS };

/** Exposed for the replay harness and tests: build a manifest from live state. */
export function snapshotManifest(huddleId: string): HuddleManifest | null {
	const state = stages.get(huddleId);
	if (!state) return null;
	return {
		huddleId,
		channelId: state.channelId,
		topic: state.topic,
		themeVersion: THEME_VERSION,
		openedAt: state.openedAt,
		closedAt: Date.now(),
		turns: state.turns,
	};
}

/** Ensure the creative dir exists at daemon start so the first bake never
 *  races the Create pane's scanner. */
export function ensureCreativeDir(): void {
	mkdirSync(join(process.env.HOME ?? "/tmp", ".8gent", "creative"), { recursive: true });
}
