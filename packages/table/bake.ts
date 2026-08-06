/**
 * 8gent Huddle Phase 1 - persistence and the bake (spec section 7).
 *
 * A huddle produces a WATCHABLE ARTIFACT afterwards, in ~/.8gent/creative/,
 * because that is where James already looks from his phone. CreativeState.scan()
 * polls that directory every 2.0s and classifies .mp4 as .video, so the huddle
 * appears as a play chip in the Create pane with NO Swift change at all.
 *
 * One source of truth (manifest.json) and three emitters:
 *   1. deck.html      HyperFrames slideshow convention (offline review path)
 *   2. deck-v2v.html  the 8GI deck2video convention (the proven path)
 *   3. the MP4        Chrome headless screenshot + ffmpeg
 *
 * WHY CHROME + FFMPEG AND NOT `hyperframes render` (a deliberate deviation,
 * stated rather than hidden): the spec itself (section 8.1) records that
 * `hyperframes render` on a multi-scene slideshow deck resolves only the first
 * composition and emits a SILENTLY TRUNCATED MP4. Verified independently on
 * this machine: the hyperframes CLI also requires Node >= 22 while this repo
 * runs Bun with Node 20 on PATH, so a per-turn render would need a version
 * shim plus a multi-second npx spawn inside a floor turn budgeted at <50ms.
 * Chrome headless screenshot plus ffmpeg is the same pipeline deck2video.py
 * already uses for the videos James watches daily. deck.html is still emitted
 * in the HyperFrames convention so the offline path stays open.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderSlide, THEME_VERSION, esc, type RenderContext } from "./slide-render";
import type { SlideSpec } from "./slide-spec";

export const CREATIVE_DIR = join(homedir(), ".8gent", "creative");
export const HUDDLES_DIR = join(homedir(), ".8gent", "huddles");

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export function findChrome(): string | null {
	return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** One turn as persisted. The single source of truth for every emitter. */
export interface BakedTurn {
	turnId: string;
	index: number;
	/** Participant id, e.g. "agent:8TO" or "human:james". */
	holder: string;
	code: string;
	name: string;
	/** Declared voice, never inferred. */
	voice: string;
	spec: SlideSpec;
	/** Content hash of the rendered slide (spec 4.6 provenance). */
	sha256: string;
	/** What was said. Also the deck's presenter note. */
	text: string;
	/** Absolute path to the turn's audio, or null (quiet hours / no TTS). */
	audioPath: string | null;
	/** Offset into audioPath where this slide's narration starts. Non-zero only
	 *  for zen-gen, where many slides share one continuous dictation recording. */
	audioOffsetMs: number;
	durationMs: number;
	/** True when the slide carries at least one unverified value. */
	hasAsserted: boolean;
	/** Dotted paths of unverified fields, carried into the manifest so the
	 *  honesty marking is auditable after the fact, not just visible on screen. */
	assertedFields: string[];
}

export interface HuddleManifest {
	huddleId: string;
	channelId: string;
	topic: string;
	themeVersion: string;
	openedAt: number;
	closedAt: number;
	turns: BakedTurn[];
}

export function huddleDir(huddleId: string): string {
	return join(HUDDLES_DIR, huddleId);
}

export function ensureHuddleDirs(huddleId: string): string {
	const dir = huddleDir(huddleId);
	for (const sub of ["", "slides", "audio", "deck"]) mkdirSync(join(dir, sub), { recursive: true });
	return dir;
}

/**
 * Render one turn's slide to disk and return its hash. Called live, during the
 * huddle, on the floor's critical path - so it does the pure render plus one
 * file write and nothing else.
 */
export function writeSlide(huddleId: string, turnId: string, spec: SlideSpec, ctx: RenderContext): { path: string; sha256: string } {
	const dir = ensureHuddleDirs(huddleId);
	const { html, sha256 } = renderSlide(spec, ctx);
	const path = join(dir, "slides", `slide-${turnId}.html`);
	writeFileSync(path, html, "utf8");
	return { path, sha256 };
}

// ── HTML to PNG ───────────────────────────────────────────────────────────

/** Screenshot one slide. Same flags deck2video.py::screenshot uses. */
export function slideToPng(htmlPath: string, pngPath: string, chrome: string): boolean {
	const r = spawnSync(
		chrome,
		[
			"--headless=new",
			"--hide-scrollbars",
			"--disable-gpu",
			"--force-device-scale-factor=1",
			"--window-size=1920,1080",
			"--virtual-time-budget=2000",
			`--screenshot=${pngPath}`,
			`file://${htmlPath}`,
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	return r.status === 0 && existsSync(pngPath);
}

// ── Emitter 2: deck-v2v.html (deck2video convention) ──────────────────────

export function emitDeckV2V(manifest: HuddleManifest): string {
	const slides = manifest.turns
		.map((t) => {
			const spec = t.spec;
			const lines: string[] = [`<h1>${esc(spec.heading)}</h1>`];
			if (spec.metric) lines.push(`<p class="metric">${esc(spec.metric.value)} <small>${esc(spec.metric.label)}</small></p>`);
			if (spec.quote) lines.push(`<blockquote>${esc(spec.quote.text)}</blockquote>`);
			if (spec.compare) lines.push(`<p>${esc(spec.compare.left)} vs ${esc(spec.compare.right)}</p>`);
			if (spec.code) lines.push(`<pre>${esc(spec.code.text)}</pre>`);
			const list = spec.bullets ?? spec.timeline;
			if (list?.length) lines.push(`<ul>${list.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
			return `  <div class="slide" data-slide="${t.index}" data-voice="${esc(t.voice)}" data-voiceover="${esc(t.text)}">
    ${lines.join("\n    ")}
  </div>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(manifest.topic || "8gent huddle")}</title></head>
<body>
${slides}
</body>
</html>
`;
}

// ── Emitter 1: deck.html (HyperFrames slideshow convention) ───────────────

export function emitDeckHyperframes(manifest: HuddleManifest): string {
	let cursor = 0;
	const scenes = manifest.turns
		.map((t) => {
			const start = cursor;
			cursor += t.durationMs;
			const spec = t.spec;
			const list = spec.bullets ?? spec.timeline ?? [];
			return `  <div class="clip" data-composition-id="turn-${t.index}" data-start="${start}" data-duration="${t.durationMs}">
    <h1>${esc(spec.heading)}</h1>
    ${list.length ? `<ul>${list.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
  </div>`;
		})
		.join("\n");

	// ttsScript / ttsAudioUrl / ttsDurationMs are RESERVED fields today.
	// Populating them costs nothing and makes the deck correct the day
	// HyperFrames wires TTS playback. Nothing here depends on them.
	const island = JSON.stringify(
		{
			slides: manifest.turns.map((t) => ({
				id: `turn-${t.index}`,
				notes: t.text,
				ttsScript: t.text,
				ttsAudioUrl: t.audioPath ? `audio/${t.audioPath.split("/").pop()}` : null,
				ttsDurationMs: t.durationMs,
			})),
		},
		null,
		2,
	);

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(manifest.topic || "8gent huddle")}</title></head>
<body data-start="0" data-duration="${cursor}" data-width="1920" data-height="1080">
${scenes}
<script type="application/hyperframes-slideshow+json">
${island}
</script>
</body>
</html>
`;
}

// ── transcript.md ─────────────────────────────────────────────────────────

export function emitTranscript(manifest: HuddleManifest): string {
	const head = [
		`# ${manifest.topic || "8gent huddle"}`,
		"",
		`Huddle: ${manifest.huddleId}`,
		`Channel: ${manifest.channelId}`,
		`Theme: ${manifest.themeVersion}`,
		`Turns: ${manifest.turns.length}`,
		"",
	];
	const body = manifest.turns.map((t) => {
		const asserted = t.assertedFields.length ? `\nUnverified fields: ${t.assertedFields.join(", ")}` : "";
		return [
			`## ${t.index + 1}. ${t.name} (${t.code})`,
			"",
			`Layout: ${t.spec.layout}`,
			`Slide sha256: ${t.sha256}`,
			`Voice: ${t.voice}`,
			`Duration: ${(t.durationMs / 1000).toFixed(2)}s`,
			`Audio: ${t.audioPath ?? "none (not synthesised)"}${asserted}`,
			"",
			t.text,
			"",
		].join("\n");
	});
	return [...head, ...body].join("\n");
}

// ── The MP4 ───────────────────────────────────────────────────────────────

export interface BakeResult {
	manifestPath: string;
	deckPath: string;
	deckV2VPath: string;
	transcriptPath: string;
	/** Absolute path to the watchable artifact, or null when it could not be built. */
	videoPath: string | null;
	/** Honest, human-readable failure reason when videoPath is null. */
	videoError?: string;
	slidePngs: string[];
}

function ffmpegClip(args: string[]): boolean {
	const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 300_000 });
	return r.status === 0;
}

/** Filesystem-safe slug. Deterministic. */
export function slugify(text: string, fallback = "huddle"): string {
	const s = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s || fallback;
}

/**
 * Bake the manifest into the artifact set. Returns paths; never throws. A
 * failure to build the MP4 is reported honestly in `videoError` rather than
 * being swallowed, because a huddle that produced no watchable file is a
 * fact James needs, not one to hide.
 */
export function bakeHuddle(manifest: HuddleManifest, stamp: string): BakeResult {
	const dir = ensureHuddleDirs(manifest.huddleId);
	mkdirSync(CREATIVE_DIR, { recursive: true });

	const manifestPath = join(dir, "manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

	const deckPath = join(dir, "deck", "deck.html");
	writeFileSync(deckPath, emitDeckHyperframes(manifest), "utf8");

	const deckV2VPath = join(dir, "deck", "deck-v2v.html");
	writeFileSync(deckV2VPath, emitDeckV2V(manifest), "utf8");

	const transcriptPath = join(dir, "transcript.md");
	writeFileSync(transcriptPath, emitTranscript(manifest), "utf8");

	const result: BakeResult = { manifestPath, deckPath, deckV2VPath, transcriptPath, videoPath: null, slidePngs: [] };

	if (manifest.turns.length === 0) {
		result.videoError = "no turns to bake";
		return result;
	}
	const chrome = findChrome();
	if (!chrome) {
		result.videoError = "no Chrome/Chromium found for slide capture";
		return result;
	}

	// 1. Every slide to a PNG.
	const work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	for (const turn of manifest.turns) {
		const htmlPath = join(dir, "slides", `slide-${turn.turnId}.html`);
		if (!existsSync(htmlPath)) {
			// Live render never happened (headless bake of an imported manifest).
			const { html } = renderSlide(turn.spec, {
				code: turn.code,
				name: turn.name,
				index: turn.index + 1,
				total: manifest.turns.length,
				assertedFields: turn.assertedFields,
			});
			writeFileSync(htmlPath, html, "utf8");
		}
		const png = join(dir, "slides", `slide-${turn.turnId}.png`);
		if (!slideToPng(htmlPath, png, chrome)) {
			result.videoError = `slide capture failed for turn ${turn.index}`;
			return result;
		}
		result.slidePngs.push(png);
	}

	// 2. One clip per turn: still frame for durationMs, with that turn's audio
	//    (sliced at audioOffsetMs for zen-gen) or matched silence.
	const clips: string[] = [];
	for (const turn of manifest.turns) {
		const png = join(dir, "slides", `slide-${turn.turnId}.png`);
		const clip = join(work, `clip-${String(turn.index).padStart(3, "0")}.mp4`);
		const secs = (turn.durationMs / 1000).toFixed(3);
		const video = ["-loop", "1", "-framerate", "30", "-t", secs, "-i", png];
		const audio = turn.audioPath && existsSync(turn.audioPath)
			? ["-ss", (turn.audioOffsetMs / 1000).toFixed(3), "-t", secs, "-i", turn.audioPath]
			: ["-f", "lavfi", "-t", secs, "-i", "anullsrc=r=44100:cl=stereo"];
		const ok = ffmpegClip([
			"-y", ...video, ...audio,
			"-map", "0:v:0", "-map", "1:a:0",
			"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "30",
			"-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
			"-t", secs, "-shortest", clip,
		]);
		if (!ok || !existsSync(clip)) {
			result.videoError = `ffmpeg clip failed for turn ${turn.index}`;
			return result;
		}
		clips.push(clip);
	}

	// 3. Concat. All clips share codec parameters by construction, so a stream
	//    copy is safe and fast.
	const listPath = join(work, "clips.txt");
	writeFileSync(listPath, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
	const outName = `huddle-${slugify(manifest.topic)}-${stamp}.mp4`;
	const outPath = join(CREATIVE_DIR, outName);
	const ok = ffmpegClip(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath]);
	if (!ok || !existsSync(outPath)) {
		result.videoError = "ffmpeg concat failed";
		return result;
	}

	// Work directory is regenerable; keep the huddle folder small.
	try {
		rmSync(work, { recursive: true, force: true });
	} catch {
		// Leaving temp clips behind is harmless and must never fail a good bake.
	}

	result.videoPath = outPath;
	return result;
}

/** Newest .mp4 in the creative dir. Used by the smoke script to prove a file
 *  actually landed where James looks, rather than trusting a return value. */
export function newestCreativeVideo(): string | null {
	if (!existsSync(CREATIVE_DIR)) return null;
	const mp4s = readdirSync(CREATIVE_DIR).filter((f) => f.endsWith(".mp4"));
	if (mp4s.length === 0) return null;
	return join(CREATIVE_DIR, mp4s.sort().at(-1) as string);
}

export { THEME_VERSION };
