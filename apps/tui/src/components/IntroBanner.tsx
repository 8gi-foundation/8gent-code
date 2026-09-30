/**
 * IntroBanner - the launch splash. Design: ~/.8gent/evidence/hud-design/INTRO-AUDIT.md
 * and MOTION.md (motion 4), Moira (8DO).
 *
 * When: first run and once after each update only (lib/intro-gate.ts).
 *
 * Direction B, "Converge" (#3159, James's pick). Sequence, 1.49 s in all
 * (lib/intro-converge.ts has the maths):
 *   T+0      dots of the braille 8 sit on a ring near the screen edge
 *   T+0..880 they warp inward, staggered, eased out, and land
 *   T+880    one warm pulse
 *   T+900    the name and one line come up on the mark's own axis
 *   T+1020   the mark is alive: a slow colour wave, a dot blinking off now
 *            and then, changing at most 8 times a second
 *   T+1490   the HUD
 *
 * Any key skips at once, from the first frame; lib/early-input.ts holds keys
 * typed before the first paint so they skip too. A printable key is handed
 * on to the input, so nothing typed during the splash is lost.
 *
 * Reduced motion (Ctrl+A, or 8GENT_REDUCED_MOTION=1), TERM=dumb, a terminal
 * without braille (ASCII) or one too small for the mark: no splash.
 * NO_COLOR: shape and weight only, no colour escapes, and the mark holds
 * still once it lands (#3158).
 *
 * Audio (macOS only): the bundled launch instrumental at 10% via afplay,
 * faded out when the splash leaves. ~/.8gent/sounds/launch.mp3 or
 * `ui.introSound` override it.
 *
 * Brand amber per BRAND.md. No purple / pink / violet.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { loadSettings } from "../../../../packages/settings/index.js";
import { useViewport } from "../hooks/useViewport.js";
import {
	ALIVE_FRAME_MS,
	type ColourKey,
	INTRO_DONE_MS,
	INTRO_PALETTE,
	LANDED_MS,
	PULSE_MS,
	introDots,
	introFrame,
	introLayout,
	introSize,
} from "../lib/intro-converge.js";
import { motionEnabled } from "../lib/motion.js";
import { drawsColour, glyphs } from "../lib/term-caps.js";

// ============================================
// Audio
// ============================================

/**
 * Resolve the bundled launch sound. Looks (in order) at:
 *   1. user override (~/.8gent/sounds/launch.mp3), copied here on first run
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
 * Tracked afplay child for the intro music. Module-level so we can kill it
 * on TUI exit, on banner dismiss, or via the /quiet command. Not detached:
 * the child dies with the TUI.
 */
let introProc: ChildProcess | null = null;
let introPath: string | null = null;
let introStartedAt = 0;
const INTRO_VOLUME = 0.1;
let exitHooksInstalled = false;

/** True if `ffplay` is on $PATH, needed for a smooth afade fade-out. */
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
}

/**
 * Fade the intro music out over `durationMs`, then stop. Kills afplay and
 * continues the track in ffplay from the same position with afade. Without
 * ffplay it cuts. Idempotent.
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
		const clear = () => {
			if (introProc === fadeProc) {
				introProc = null;
				introPath = null;
			}
		};
		fadeProc.on("exit", clear);
		fadeProc.on("error", clear);
	} catch {
		/* ffplay spawn failed; afplay is already stopped */
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

/** Play the launch sound once, quietly. `ui.introSound` wins. macOS only. */
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
		path = userOverride.startsWith("~") ? userOverride.replace("~", homedir()) : userOverride;
		if (!existsSync(path)) path = resolveLaunchSound();
	} else {
		path = resolveLaunchSound();
	}
	if (!path) return;
	try {
		installIntroExitHooks();
		stopIntroSound();
		const proc = spawn("afplay", ["-v", String(INTRO_VOLUME), path], { stdio: "ignore" });
		const clear = () => {
			if (introProc === proc) {
				introProc = null;
				introPath = null;
			}
		};
		proc.on("exit", clear);
		proc.on("error", clear);
		introProc = proc;
		introPath = path;
		introStartedAt = Date.now();
	} catch {
		// best-effort; never break the banner
	}
}

/** Exposed so app.tsx and slash commands can stop the music on demand.
 * Fades over 2.4 s by default; `{ abrupt: true }` kills it at once. */
export function stopIntroMusic(opts?: { abrupt?: boolean; durationMs?: number }): void {
	if (opts?.abrupt) {
		stopIntroSound();
		return;
	}
	fadeOutIntroSound(opts?.durationMs ?? 2400);
}

// ============================================
// Copy and timeline (pure, tested in lib/intro-converge.ts)
// ============================================

export { INTRO_DONE_MS, INTRO_LINE, INTRO_NAME } from "../lib/intro-converge.js";

/**
 * The text a key press hands on to the input: printable characters only, and
 * nothing for a bare space, Enter, Esc or a control chord.
 */
export function carriedText(
	input: string,
	key: { ctrl?: boolean; meta?: boolean; escape?: boolean; return?: boolean },
): string {
	if (key.ctrl || key.meta || key.escape || key.return) return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
	const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
	return clean.trim() ? clean : "";
}

// ============================================
// Component
// ============================================

interface IntroBannerProps {
	/** Called once, with any printable text typed to skip the splash. */
	onDone: (carried?: string) => void;
	/** Animations on (Ctrl+A). 8GENT_REDUCED_MOTION=1 also turns motion off. */
	animate?: boolean;
	version?: string;
	/** Speed multiplier for tests. 10 = ten times faster. Default 1. */
	speed?: number;
	/** Override the glyph capability check (tests). */
	rich?: boolean;
	/** Override the colour check (tests). Defaults to NO_COLOR / TERM=dumb. */
	colour?: boolean;
	/** Play the launch music. Default true. */
	sound?: boolean;
}

/**
 * The colour a run is drawn in, or undefined for none. Under NO_COLOR (or
 * TERM=dumb) nothing gets a colour, so Ink writes no colour escapes (#3158).
 */
export function runColour(colour: ColourKey | null, inColour: boolean): string | undefined {
	return inColour && colour ? INTRO_PALETTE[colour] : undefined;
}

/** Frame interval while the dots fly; the living mark after landing changes at 8 fps. */
const FLY_FRAME_MS = 33;

export function IntroBanner({
	onDone,
	animate = true,
	version,
	speed = 1,
	rich,
	colour,
	sound = true,
}: IntroBannerProps) {
	const viewport = useViewport();
	const [elapsed, setElapsed] = useState(0);
	const done = useRef(false);
	const motion = motionEnabled(animate);
	const isRich = rich ?? glyphs().eight === null;
	const inColour = colour ?? drawsColour();
	const size = isRich ? introSize(viewport.width, viewport.height) : null;
	// Reduced motion, a terminal that cannot draw braille, or one too small for
	// the mark: no splash at all. The HUD header already carries the name.
	// TERM=dumb cannot place a cursor, so it cannot draw a moving splash.
	const skip = !motion || size === null || process.env.TERM === "dumb";
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	const finishRef = useRef((carried?: string) => {
		if (done.current) return;
		done.current = true;
		fadeOutIntroSound(2400);
		onDoneRef.current(carried);
	});

	useEffect(() => {
		if (sound && !skip) playIntroSound();
	}, [sound, skip]);

	useEffect(() => {
		if (skip) {
			finishRef.current();
			return;
		}
		const start = performance.now();
		let timer: ReturnType<typeof setTimeout>;
		const step = () => {
			const ms = (performance.now() - start) * speed;
			if (ms >= INTRO_DONE_MS) {
				finishRef.current();
				return;
			}
			setElapsed(ms);
			// While dots fly, about 30 fps. Once the mark is home it only changes
			// on the living beat, so there is nothing to redraw in between.
			const next =
				ms < LANDED_MS + PULSE_MS ? FLY_FRAME_MS : ALIVE_FRAME_MS - (ms % ALIVE_FRAME_MS);
			timer = setTimeout(step, Math.max(8, next / speed));
		};
		step();
		return () => clearTimeout(timer);
	}, [skip, speed]);

	useInput((input, key) => {
		finishRef.current(carriedText(input, key));
	});

	if (done.current || skip || size === null) return null;
	// The first commit draws nothing: a key pressed before the first paint is
	// read in that beat, so it skips the splash before a single frame shows.
	// The clock started at mount, so this adds nothing to the 1.49 s.
	if (elapsed < FLY_FRAME_MS / 2) return null;

	const layout = introLayout(viewport.width, viewport.height, size);
	const frame = introFrame(viewport.width, viewport.height, layout, introDots(size), elapsed, {
		// Colour carries the life: without it the mark holds still.
		alive: inColour,
		hint: `any key skips${version ? ` · v${version}` : ""}`,
	});

	return (
		<Box flexDirection="column">
			{frame.map((runs, r) => (
				// Rows are positional and never reorder.
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Text key={r} wrap="truncate-end">
					{runs.length === 0
						? " "
						: runs.map((run, i) => (
								// Runs are positional within a fixed row.
								// react-doctor-disable-next-line react-doctor/no-array-index-as-key
								<Text key={i} color={runColour(run.colour, inColour)} bold={run.bold}>
									{run.text}
								</Text>
							))}
				</Text>
			))}
		</Box>
	);
}
