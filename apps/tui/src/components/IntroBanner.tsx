/**
 * IntroBanner — cinematic 8GENT wordmark on TUI launch with cascade reveal.
 *
 * Sequence over ~13500ms (paced to the narration track):
 *   T+0      wordmark begins fade-in + music + narration both start
 *   T+1500   flourish rule + ∞ appears
 *   T+2500   title ("Your intelligence shouldn't be a subscription.") types in
 *   T+5500   subhead ("Take back custody of your cognition.") types in
 *   T+6800   the greeting line reveals, IF one arrived in time (see
 *            "Local greeting" below) — it's generated well before this,
 *            so it lands beside the body line rather than competing with it
 *   T+9000   body line ("Infinite General Intelligence. free. local. open.") types in
 *   T+12500  hold completes
 *   T+13500  dismiss (fades music + narration together over 2.4s)
 *
 * Skippable: esc / q / space / Ctrl+C, but ONLY after the body line has
 *            finished typing in. Stray terminal events during launch (paste
 *            markers, focus reports, accidental keystrokes) cannot dismiss
 *            it early.
 * Opt-out:   set 8GENT_NO_INTRO=1 to skip entirely.
 *
 * Audio: bundled `apps/tui/sounds/launch.mp3` is played at 65% via afplay.
 * On first run we copy the bundled file to `~/.8gent/sounds/launch.mp3` so
 * the user can swap it (or set `ui.introSound` to override the path).
 *
 * Local greeting: the splash asks the LOCAL model (ollama, 127.0.0.1:11434)
 * to write its own one-line greeting, on the spot, every launch — the
 * product demonstrating itself in its own splash screen, free and local,
 * no key required. Fired the moment the banner mounts, via the existing
 * OllamaClient (packages/eight/clients/ollama.ts) — no second client. Never
 * awaited by the render loop: if it hasn't arrived by the time it would
 * show, or the local endpoint is down, slow, or empty, that slot renders
 * NOTHING. No canned greeting, no sample text, ever. See generateGreeting()
 * below.
 *
 * Brand amber per BRAND.md. No purple / pink / violet.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { loadSettings } from "../../../../packages/settings/index.js";
// Same existing client the rest of the TUI uses to talk to Ollama — not a
// second, hand-rolled HTTP client.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { OllamaClient } from "../../../../packages/eight/clients/ollama.js";
import { t } from "../theme.js";

/**
 * Resolve the bundled launch sound. Looks (in order) at:
 *   1. user override (~/.8gent/sounds/launch.mp3) — copied here on first run
 *   2. dev source: apps/tui/sounds/launch.mp3 (when running from src)
 *   3. built dist: dist/sounds/launch.mp3 (when running the npm-published bin)
 * Returns null if nothing usable is found.
 */
function resolveLaunchSound(): string | null {
	const userPath = join(homedir(), ".8gent", "sounds", "launch.mp3");
	if (existsSync(userPath)) return userPath;

	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "../../sounds/launch.mp3"),
		resolve(here, "../sounds/launch.mp3"),
		resolve(here, "./sounds/launch.mp3"),
	];
	for (const c of candidates) {
		if (existsSync(c)) {
			try {
				mkdirSync(dirname(userPath), { recursive: true });
				copyFileSync(c, userPath);
				return userPath;
			} catch {
				return c;
			}
		}
	}
	return null;
}

/**
 * Resolve the bundled splash narration MP3. Same lookup pattern as
 * resolveLaunchSound — user override + dev source + built dist. Pre-rendered
 * via KittenTTS (Jasper voice) at build time; never regenerated at runtime
 * to avoid Python + KittenTTS being a runtime dep of the TUI.
 */
function resolveNarrationSound(): string | null {
	const userPath = join(homedir(), ".8gent", "sounds", "splash-narration.mp3");
	if (existsSync(userPath)) return userPath;

	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "../../sounds/splash-narration.mp3"),
		resolve(here, "../sounds/splash-narration.mp3"),
		resolve(here, "./sounds/splash-narration.mp3"),
	];
	for (const c of candidates) {
		if (existsSync(c)) {
			try {
				mkdirSync(dirname(userPath), { recursive: true });
				copyFileSync(c, userPath);
				return userPath;
			} catch {
				return c;
			}
		}
	}
	return null;
}

/**
 * Tracked afplay child for the intro music. Module-level so we can
 * kill it on TUI exit, on banner dismiss, or via the /quiet command.
 *
 * NOT detached, NOT unref'd — the child dies with the TUI. Earlier
 * versions used `{ detached: true }` + `proc.unref()` which made the
 * music outlive even Ctrl+C; that was the bug.
 */
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

let introProc: ChildProcess | null = null;
let introPath: string | null = null;
let introStartedAt = 0;
// Music sits under the narration. Lowered from 0.15 to 0.10 when the
// splash-narration track was added so Jasper's voice can speak clearly
// over it without the music drowning him.
const INTRO_VOLUME = 0.10;

// Pre-rendered narration via KittenTTS (Jasper voice). Plays in parallel
// with the music. Bundled at apps/tui/sounds/splash-narration.mp3.
// KittenTTS-only per the no-ElevenLabs rule.
let narrationProc: ChildProcess | null = null;
const NARRATION_VOLUME = 0.55;
let exitHooksInstalled = false;

/** True if `ffplay` is on $PATH — needed for the proper afade-based
 * gradual fade-out. afplay (default macOS player) has no fade or seek
 * support so we fall back to an abrupt cut without ffmpeg. */
function hasFfplay(): boolean {
	try {
		execSync("command -v ffplay", { stdio: "ignore", timeout: 1500 });
		return true;
	} catch {
		return false;
	}
}

function stopIntroSound(): void {
	const proc = introProc;
	introProc = null;
	introPath = null;
	if (proc) {
		try {
			proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
	// Also kill any in-flight narration. Both tracks live or die together.
	const nproc = narrationProc;
	narrationProc = null;
	if (nproc) {
		try {
			nproc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

/**
 * Gradually fade out the intro music over `durationMs`, then stop.
 * Strategy: kill the current afplay, then immediately spawn an
 * `ffplay` continuation that picks up at the same position and applies
 * an `afade=t=out` filter for a smooth fade. Falls back to abrupt cut
 * if ffplay isn't available — better silence than a broken stream.
 *
 * Idempotent: calling while a fade is already in flight is a no-op.
 */
function fadeOutIntroSound(durationMs = 2400): void {
	const proc = introProc;
	const path = introPath;
	if (!proc || !path) return;
	const elapsedSec = (Date.now() - introStartedAt) / 1000;
	if (!hasFfplay()) {
		stopIntroSound();
		return;
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	introProc = null;
	introPath = null;
	// Narration is short (~13s) and usually finished before fade fires;
	// when the user skips with Esc/q mid-narration, just cut it abruptly —
	// music fade-out is the audible cushion, narration cut is fine.
	const nproc = narrationProc;
	narrationProc = null;
	if (nproc) {
		try {
			nproc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
	const fadeSec = Math.max(0.5, durationMs / 1000);
	try {
		const fadeProc = spawn(
			"ffplay",
			[
				"-nodisp",
				"-autoexit",
				"-loglevel",
				"quiet",
				"-ss",
				String(elapsedSec),
				"-i",
				path,
				"-af",
				`volume=${INTRO_VOLUME},afade=t=out:st=0:d=${fadeSec}`,
				"-t",
				String(fadeSec),
			],
			{ stdio: "ignore" },
		);
		introProc = fadeProc;
		introPath = path;
		introStartedAt = Date.now() - elapsedSec * 1000;
		fadeProc.on("exit", () => {
			if (introProc === fadeProc) {
				introProc = null;
				introPath = null;
			}
		});
		fadeProc.on("error", () => {
			if (introProc === fadeProc) {
				introProc = null;
				introPath = null;
			}
		});
	} catch {
		/* ffplay spawn failed — leave silence, afplay already killed */
	}
}

function installIntroExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	process.on("exit", stopIntroSound);
	process.on("SIGINT", () => {
		stopIntroSound();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		stopIntroSound();
		process.exit(143);
	});
	process.on("uncaughtException", (err) => {
		stopIntroSound();
		throw err;
	});
}

/**
 * Play the launch sound once. Volume 15% (0.15) via `afplay -v` — the
 * launch instrumental is mastered loud, so we keep it well below the
 * splash text reveal and any narration we layer on top later.
 *
 * The child IS tracked and dies with the TUI under any exit path.
 * Banner dismiss also calls stopIntroSound() so the music goes away
 * once the splash is gone.
 *
 * `ui.introSound` setting still wins if the user set an absolute path.
 * Non-macOS: silent.
 */
function playIntroSound(): void {
	if (platform() !== "darwin") return;
	let userOverride = "";
	try {
		userOverride = loadSettings()?.ui?.introSound ?? "";
	} catch {
		/* settings unavailable; fall through to bundled */
	}
	let path: string | null;
	if (userOverride) {
		path = userOverride.startsWith("~")
			? userOverride.replace("~", homedir())
			: userOverride;
		if (!existsSync(path)) path = resolveLaunchSound();
	} else {
		path = resolveLaunchSound();
	}
	if (!path) return;
	try {
		installIntroExitHooks();
		// Kill any prior intro proc — should never happen but defensive.
		stopIntroSound();
		const proc = spawn("afplay", ["-v", String(INTRO_VOLUME), path], {
			stdio: "ignore",
		});
		proc.on("exit", () => {
			if (introProc === proc) {
				introProc = null;
				introPath = null;
			}
		});
		proc.on("error", () => {
			if (introProc === proc) {
				introProc = null;
				introPath = null;
			}
		});
		introProc = proc;
		introPath = path;
		introStartedAt = Date.now();
	} catch {
		// best-effort; never break the banner
	}

	// Layer in the pre-rendered narration (Jasper voice). Spawned in
	// parallel with the music; killed together via stopIntroSound. Pure
	// best-effort — if the narration MP3 is missing or afplay errors out,
	// the splash still plays with music only.
	try {
		const narrationPath = resolveNarrationSound();
		if (!narrationPath) return;
		const nproc = spawn("afplay", ["-v", String(NARRATION_VOLUME), narrationPath], {
			stdio: "ignore",
		});
		nproc.on("exit", () => {
			if (narrationProc === nproc) narrationProc = null;
		});
		nproc.on("error", () => {
			if (narrationProc === nproc) narrationProc = null;
		});
		narrationProc = nproc;
	} catch {
		// best-effort; narration is decorative
	}
}

/** Exposed so app.tsx and slash commands can stop the music on demand.
 * Default behaviour fades over 2.4s; pass `{ abrupt: true }` for an
 * instant kill (e.g. when the TUI itself is exiting). */
export function stopIntroMusic(opts?: { abrupt?: boolean; durationMs?: number }): void {
	if (opts?.abrupt) {
		stopIntroSound();
		return;
	}
	fadeOutIntroSound(opts?.durationMs ?? 2400);
}

// Block-letter "8GENT" - 5 rows tall, fits in ~46 cols.
const BANNER_LINES: readonly string[] = [
	" ▄▄▄▄    ▄▄▄▄▄  ▄▄▄▄▄  ▄▄▄ ▄▄  ▄▄▄▄▄▄ ",
	"▐▌  ▐▌  ▐▌      ▐▌     ▐▌▀▄ ▐▌   ▐▌   ",
	" ▀▀▄▀    ▐▌ ▀▀  ▐▀▀▀   ▐▌ ▀▄▐▌   ▐▌   ",
	"▐▌  ▐▌  ▐▌  ▐▌  ▐▌     ▐▌  ▀▐▌   ▐▌   ",
	" ▀▀▀▀    ▀▀▀▀▀  ▀▀▀▀▀  ▀▀   ▀▀   ▀▀   ",
] as const;

const FLOURISH = "─────────────  ∞  ─────────────";
const TITLE = "Your intelligence shouldn't be a subscription.";
const SUBHEAD = "Take back custody of your cognition.";
const BODY = "Infinite General Intelligence. free. local. open.";

// Cinematic schedule — paced to the slow-starting launch instrumental.
// Skip entirely with 8GENT_NO_INTRO=1 or 8GENT_LITE=1.
// Paced to the KittenTTS Jasper narration (~13.2s):
//   ~1.0s pre-pad, title line, gap, subhead line, gap, body line.
// Visual reveals lead the narration slightly so the user sees the text
// just before Jasper speaks it.
const T_WORDMARK = 0;
const T_FLOURISH = 1500;
const T_TITLE = 2500;
const T_SUBHEAD = 5500;
// The local greeting reveals here at the earliest — after the subhead has
// had a beat to read, before the body line starts typing at T_BODY. Gated
// on the greeting having actually arrived by then; generation starts at
// mount (T+0) with its own hard cap (GREETING_TIMEOUT_MS). If it arrives
// later than T_BRIEF it still shows the moment it lands; if it never
// arrives, or arrives after T_DONE, that slot just stays blank.
const T_BRIEF = 6800;
const T_BODY = 9000;
const T_HOLD_END = 12500;
const T_DONE = 13500;

// Typewriter speed — characters revealed per second.
const TYPE_CPS = 24;

function typedSlice(line: string, elapsed: number, startMs: number): string {
	if (elapsed < startMs) return "";
	const chars = Math.floor(((elapsed - startMs) / 1000) * TYPE_CPS);
	return line.slice(0, Math.min(chars, line.length));
}

// ============================================
// Local greeting — generated by the local model, on the spot, every launch
// ============================================

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
/**
 * Hard cap on the whole generation attempt. Measured on this machine with a
 * suitable instruct model (pickLocalModel's "tools"-tier preference): a real
 * greeting for real context comes back in ~2.4s. 6s leaves headroom for a
 * loaded machine while still landing well before T_HOLD_END (12500) and far
 * short of T_DONE (13500) — a slow or hung local server still can never
 * stall or extend the splash itself.
 */
const GREETING_TIMEOUT_MS = 6000;
const GREETING_MAX_WORDS = 14;
const GREETING_MAX_CHARS = 110;

/** Resolve a promise to `null` instead of hanging or throwing past `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => resolvePromise(null), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolvePromise(v);
			},
			() => {
				clearTimeout(timer);
				resolvePromise(null);
			},
		);
	});
}

/**
 * True only if there's at least one prior session file on disk. Cheap:
 * a single readdir, no file contents read. Feeds "first run" context to the
 * greeting prompt — never rendered directly.
 */
function hasPriorSessions(): boolean {
	try {
		const dir = join(homedir(), ".8gent", "sessions");
		return readdirSync(dir).some((f) => f.endsWith(".json"));
	} catch {
		return false;
	}
}

function timeOfDayLabel(hour: number): string {
	if (hour < 5) return "the middle of the night";
	if (hour < 12) return "the morning";
	if (hour < 17) return "the afternoon";
	if (hour < 21) return "the evening";
	return "night";
}

interface OllamaTagModel {
	name: string;
	size?: number;
	capabilities?: string[];
}

/**
 * Ask the local ollama endpoint which models it actually has and pick one
 * likely to answer a short greeting quickly — never hardcoded, never assumed
 * installed. Uses ollama's own real `capabilities` and `size` fields:
 *
 * - drops "embedding" models (can't chat) and "thinking" models (this
 *   machine's flagged reasoning model took 25GB of GPU memory and a 262k
 *   context just to answer "hello" — measured, not assumed)
 * - prefers models flagged "tools" (general instruct models) over bare
 *   completion-only ones — measured on this machine, a completion-only 1B
 *   model reasoned silently for over 60s despite carrying no "thinking" tag
 *   at all, so that tag alone isn't a reliable enough signal
 * - smallest first within whichever tier is available
 *
 * Short-timeout, best-effort: returns null (not a guess) if the endpoint is
 * down or unreachable in time, or nothing usable is installed.
 */
async function pickLocalModel(baseUrl: string): Promise<string | null> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(700) });
		if (!res.ok) return null;
		const data = (await res.json()) as { models?: OllamaTagModel[] };
		const usable = (data.models || []).filter((m) => {
			const caps = m.capabilities || [];
			return !caps.includes("embedding") && !caps.includes("thinking");
		});
		if (usable.length === 0) return null;
		const withTools = usable.filter((m) => (m.capabilities || []).includes("tools"));
		const pool = withTools.length > 0 ? withTools : usable;
		pool.sort(
			(a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY),
		);
		return pool[0]?.name ?? null;
	} catch {
		return null;
	}
}

/**
 * Reasoning-style local models (seen on this machine: an OpenBMB MiniCPM
 * build) wrap chain-of-thought in a `<think>...</think>` block before the
 * real answer. Strip it — the greeting is whatever comes after, never the
 * reasoning itself. If the block never closes (generation cut off mid
 * thought), there IS no real answer yet: return empty rather than showing
 * raw reasoning text as if it were the greeting.
 */
function extractAnswer(raw: string): string {
	const lower = raw.toLowerCase();
	const closeIdx = lower.indexOf("</think>");
	if (closeIdx !== -1) return raw.slice(closeIdx + "</think>".length).trim();
	if (lower.includes("<think>")) return "";
	return raw.trim();
}

/** Strip quotes/newlines, collapse whitespace, ban em/en dashes, hard-cap
 * length. Never trust the model to have followed the brevity instruction. */
function sanitizeGreeting(raw: string): string {
	let cleaned = raw
		.replace(/["'“”‘’]/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/[—–]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	const words = cleaned.split(" ").filter(Boolean);
	if (words.length > GREETING_MAX_WORDS) cleaned = words.slice(0, GREETING_MAX_WORDS).join(" ");
	if (cleaned.length > GREETING_MAX_CHARS) cleaned = cleaned.slice(0, GREETING_MAX_CHARS).trim();
	return cleaned;
}

/**
 * Generate a one-line greeting with the local model, right now, in context.
 * Plain completion only (OllamaClient.generate — no `tools` array), which
 * sidesteps the qwen3.8:27b-mlx hang on tool-call requests (8gi-foundation/
 * 8gent-code#2894) entirely: a greeting needs no tools.
 *
 * Returns null (never a canned string) if the endpoint is unreachable, slow,
 * or the model returns nothing usable. Every context value fed to the prompt
 * is real and cheap: wall-clock hour, the cwd's own name, whether any prior
 * session exists.
 *
 * `baseUrl` defaults to the real local endpoint; exported (with the param)
 * so the down/unreachable path can be exercised directly in a test against a
 * deliberately dead URL, without touching or depending on the real service.
 */
export async function generateGreeting(baseUrl: string = OLLAMA_BASE_URL): Promise<string | null> {
	const model = await pickLocalModel(baseUrl);
	if (!model) return null;

	const timeLabel = timeOfDayLabel(new Date().getHours());
	const workspaceName = basename(process.cwd());
	const firstRun = !hasPriorSessions();

	const context = [
		`It is ${timeLabel}.`,
		workspaceName ? `They're working in a folder called "${workspaceName}".` : "",
		firstRun ? "This is the first time they've opened this tool." : "",
	]
		.filter(Boolean)
		.join(" ");

	const prompt =
		`Greet the person opening their terminal AI assistant right now. ${context} Reply with ONE warm, natural greeting sentence, ${GREETING_MAX_WORDS} words or fewer. No quotes, no dashes, no mention that you are an AI or a model. Just the greeting, nothing else.`;

	try {
		const client = new OllamaClient(model, baseUrl);
		const raw = await withTimeout(client.generate(prompt), GREETING_TIMEOUT_MS);
		if (!raw) return null;
		const cleaned = sanitizeGreeting(extractAnswer(raw));
		return cleaned.length >= 3 ? cleaned : null;
	} catch {
		return null;
	}
}

interface IntroBannerProps {
	onDone: () => void;
	/** Speed multiplier for tests. 0.1 = 10x faster. Default 1. */
	speed?: number;
}

export function IntroBanner({ onDone, speed = 1 }: IntroBannerProps) {
	const [elapsed, setElapsed] = useState(0);
	const [greeting, setGreeting] = useState<string | null>(null);

	useEffect(() => {
		playIntroSound();
	}, []);

	// Fire the local greeting the moment the banner mounts. Fully
	// fire-and-forget from the render loop's perspective: generateGreeting()
	// has its own hard timeout, and this effect never blocks a render or the
	// 40ms animation tick. If it resolves null (endpoint down, slow, empty
	// model list, junk output) the greeting slot simply never appears —
	// never a canned fallback.
	useEffect(() => {
		let cancelled = false;
		generateGreeting()
			.then((text) => {
				if (!cancelled && text) setGreeting(text);
			})
			.catch(() => {
				/* generateGreeting already swallows its own errors; defensive only */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Single dismiss handler — gracefully fades out the music, then runs
	// onDone. The fade overlaps with the splash leaving so by the time
	// the user is in chat, the music is already half-faded. Without this
	// the slow instrumental would either outlive the splash or get cut
	// abruptly mid-note.
	const dismiss = () => {
		fadeOutIntroSound(2400);
		onDone();
	};

	useEffect(() => {
		const start = performance.now();
		const tick = setInterval(() => {
			const ms = (performance.now() - start) / speed;
			setElapsed(ms);
			if (ms >= T_DONE) {
				clearInterval(tick);
				dismiss();
			}
		}, 40);
		return () => clearInterval(tick);
	}, []);

	useInput((input, key) => {
		// Skip is gated: only Esc / q / space / Ctrl+C dismiss, and only AFTER
		// the body line has finished animating in. Earlier launches died at
		// ~3s because stray terminal events (bracketed-paste markers, focus
		// reports, accidental keystrokes during heavy init) fired this
		// callback while the user had not yet seen the subtitle or body.
		const bodyDoneAt = T_BODY + (BODY.length / TYPE_CPS) * 1000;
		if (elapsed < bodyDoneAt) return;
		if (key.escape || input === "q" || input === " " || (key.ctrl && input === "c")) {
			dismiss();
		}
	});

	if (elapsed >= T_DONE) return null;

	const showFlourish = elapsed >= T_FLOURISH;
	const showTitle = elapsed >= T_TITLE;
	const showSubhead = elapsed >= T_SUBHEAD;
	const showBody = elapsed >= T_BODY;
	const inFadeOut = elapsed >= T_HOLD_END;

	const wordmarkDim = elapsed < T_WORDMARK + 350 || inFadeOut;
	const flourishDim = !showFlourish || elapsed < T_FLOURISH + 300 || inFadeOut;

	const titleText = typedSlice(TITLE, elapsed, T_TITLE);
	const subheadText = typedSlice(SUBHEAD, elapsed, T_SUBHEAD);
	const bodyText = typedSlice(BODY, elapsed, T_BODY);

	const titleTyping = showTitle && titleText.length < TITLE.length;
	const subheadTyping = showSubhead && subheadText.length < SUBHEAD.length;
	const bodyTyping = showBody && bodyText.length < BODY.length;

	// The greeting only shows once it has both arrived AND its reveal time has
	// come — never a placeholder while waiting, never shown before its beat.
	const showGreeting = elapsed >= T_BRIEF && !!greeting;

	return (
		<Box flexDirection="column" alignItems="center" paddingY={1}>
			{/* BANNER_LINES is a module-level constant ASCII banner; rows are positional and never reorder. */}
			{BANNER_LINES.map((line, i) => (
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Text key={i} color={t.orange} bold dimColor={wordmarkDim}>
					{line}
				</Text>
			))}
			<Box marginTop={1} minHeight={1}>
				<Text color={t.textPrimary} dimColor={flourishDim}>
					{showFlourish ? FLOURISH : ""}
				</Text>
			</Box>
			<Box marginTop={1} minHeight={1}>
				<Text color={t.textPrimary} bold dimColor={inFadeOut}>
					{titleText}
					{titleTyping ? "▌" : ""}
				</Text>
			</Box>
			<Box marginTop={0} minHeight={1}>
				<Text color={t.textSecondary} dimColor={inFadeOut}>
					{subheadText}
					{subheadTyping ? "▌" : ""}
				</Text>
			</Box>
			<Box marginTop={0} minHeight={1}>
				<Text color={t.textTertiary} dimColor>
					{bodyText}
					{bodyTyping ? "▌" : ""}
				</Text>
			</Box>
			{showGreeting && (
				<Box marginTop={1} minHeight={1}>
					<Text color={t.textSecondary} dimColor={inFadeOut}>
						{greeting}
					</Text>
				</Box>
			)}
			{!inFadeOut && elapsed > T_BODY + 400 && (
				<Box marginTop={1}>
					<Text color={t.textDim}>esc / q / space to skip</Text>
				</Box>
			)}
		</Box>
	);
}
