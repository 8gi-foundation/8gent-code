/**
 * IntroBanner - the launch splash. Design: ~/.8gent/evidence/hud-design/INTRO-AUDIT.md
 * and MOTION.md (motion 4), Moira (8DO).
 *
 * When: first run and once after each update only (lib/intro-gate.ts).
 *
 * Sequence, about 1.5 s in all:
 *   T+0      the figure-8 mark, the wordmark and the hint, still
 *   T+150    three lines type into a fixed left column, 300 ms each
 *   T+1250   the mark collapses into the header's 8: 4 frames x 60 ms
 *   T+1490   the HUD
 *
 * Any key skips at once, from the first frame. A printable key is handed on
 * to the input, so nothing typed during the splash is lost.
 *
 * Reduced motion (Ctrl+A, or 8GENT_REDUCED_MOTION=1): the final frame is
 * drawn at once, nothing types and nothing collapses.
 *
 * Layout: the whole block is centred vertically. The three lines share one
 * left column whose width is the longest line, so typing only grows to the
 * right and nothing jitters sideways.
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
import { motionEnabled } from "../lib/motion.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";
import { Mark8, type MarkSize, markSize } from "./Mark8.js";

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
// Copy and timeline (pure, tested)
// ============================================

export const INTRO_LINES = [
	"Your intelligence shouldn't be a subscription.",
	"Take back custody of your cognition.",
	"Infinite General Intelligence. Free, local, open.",
] as const;

/** Theme tokens per line, then the hint. All at least 4.5:1 on the background. */
export const INTRO_LINE_TOKENS = ["textPrimary", "textSecondary", "textTertiary"] as const;
export const INTRO_HINT_TOKEN = "textTertiary" as const;

export const INTRO_TYPE_START_MS = 150;
/** Each line types in this long. */
export const INTRO_LINE_MS = 300;
export const INTRO_COLLAPSE_AT_MS = 1250;
export const COLLAPSE_FRAME_MS = 60;
/** Eased progress of the collapse, one entry per frame; ends exactly on the header. */
export const COLLAPSE_EASE: readonly number[] = [0.35, 0.7, 0.9, 1];
export const COLLAPSE_SIZES: readonly MarkSize[] = ["medium", "small", "header", "header"];
export const INTRO_DONE_MS = INTRO_COLLAPSE_AT_MS + COLLAPSE_FRAME_MS * COLLAPSE_EASE.length;

/** Width of the shared text column: the longest line, so typing never re-centres. */
export const INTRO_BLOCK_WIDTH = Math.max(...INTRO_LINES.map((l) => l.length));

const WORDMARK_WIDTH = "8gent Code".length;

/** Where the header's "8" sits: row 1, column 2, inside the brand pill's border. */
export const HEADER_EIGHT = { row: 1, col: 2 } as const;

/** How much of line `i` has typed in at `elapsed` ms. Motion off shows it all. */
export function typedLine(i: number, elapsed: number, animate: boolean): string {
	const line = INTRO_LINES[i] ?? "";
	if (!animate) return line;
	const start = INTRO_TYPE_START_MS + i * INTRO_LINE_MS;
	if (elapsed <= start) return "";
	const chars = Math.ceil(((elapsed - start) / INTRO_LINE_MS) * line.length);
	return line.slice(0, Math.min(chars, line.length));
}

/** The largest mark that leaves the whole block room in `rows` terminal rows. */
export function introMarkSize(rows: number): MarkSize {
	if (rows >= 30) return "intro";
	if (rows >= 24) return "medium";
	if (rows >= 18) return "small";
	return "header";
}

/** Rows below the mark: gap, wordmark, gap, three lines, gap, hint. */
export const BELOW_MARK_ROWS = 8;

export interface IntroLayout {
	size: MarkSize;
	top: number;
	markLeft: number;
	wordLeft: number;
	blockLeft: number;
	markCols: number;
	markRows: number;
}

/** Centred placement of the splash block in a cols x rows viewport. */
export function introLayout(cols: number, rows: number, rich: boolean): IntroLayout {
	const size = introMarkSize(rows);
	const m = markSize(size, rich);
	const height = m.rows + BELOW_MARK_ROWS;
	return {
		size,
		top: Math.max(0, Math.floor((rows - height) / 2)),
		markLeft: Math.max(0, Math.floor((cols - m.cols) / 2)),
		wordLeft: Math.max(0, Math.floor((cols - WORDMARK_WIDTH) / 2)),
		blockLeft: Math.max(1, Math.floor((cols - INTRO_BLOCK_WIDTH) / 2)),
		markCols: m.cols,
		markRows: m.rows,
	};
}

export interface CollapseFrame {
	size: MarkSize;
	top: number;
	left: number;
}

/**
 * The collapse, one frame per COLLAPSE_EASE entry. The mark's centre travels
 * from its splash position to the header's 8 while it steps down in size, so
 * the last frame lands the small braille 8 over the header's 8.
 */
export function collapseFrames(layout: IntroLayout, rich: boolean): CollapseFrame[] {
	const fromY = layout.top + layout.markRows / 2;
	const fromX = layout.markLeft + layout.markCols / 2;
	const toY = HEADER_EIGHT.row + 0.5;
	const toX = HEADER_EIGHT.col + 0.5;
	return COLLAPSE_EASE.map((p, k) => {
		const size = COLLAPSE_SIZES[k] ?? "header";
		const m = markSize(size, rich);
		const cy = fromY + (toY - fromY) * p;
		const cx = fromX + (toX - fromX) * p;
		return {
			size,
			top: Math.max(0, Math.round(cy - m.rows / 2)),
			left: Math.max(0, Math.round(cx - m.cols / 2)),
		};
	});
}

/** The collapse frame index at `elapsed`, or -1 before the collapse starts. */
export function collapseIndex(elapsed: number): number {
	if (elapsed < INTRO_COLLAPSE_AT_MS) return -1;
	return Math.min(
		COLLAPSE_EASE.length - 1,
		Math.floor((elapsed - INTRO_COLLAPSE_AT_MS) / COLLAPSE_FRAME_MS),
	);
}

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
	/** Play the launch music. Default true. */
	sound?: boolean;
}

export function IntroBanner({
	onDone,
	animate = true,
	version,
	speed = 1,
	rich,
	sound = true,
}: IntroBannerProps) {
	const viewport = useViewport();
	const [elapsed, setElapsed] = useState(0);
	const done = useRef(false);
	const motion = motionEnabled(animate);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	const finishRef = useRef((carried?: string) => {
		if (done.current) return;
		done.current = true;
		fadeOutIntroSound(2400);
		onDoneRef.current(carried);
	});

	useEffect(() => {
		if (sound) playIntroSound();
	}, [sound]);

	useEffect(() => {
		// Reduced motion: one still frame, then the HUD. No ticking repaints.
		if (!motion) {
			const timer = setTimeout(() => finishRef.current(), INTRO_DONE_MS / speed);
			return () => clearTimeout(timer);
		}
		const start = performance.now();
		const tick = setInterval(() => {
			const ms = (performance.now() - start) * speed;
			setElapsed(ms);
			if (ms >= INTRO_DONE_MS) {
				clearInterval(tick);
				finishRef.current();
			}
		}, 30);
		return () => clearInterval(tick);
	}, [motion, speed]);

	useInput((input, key) => {
		finishRef.current(carriedText(input, key));
	});

	if (done.current) return null;

	const isRich = rich ?? glyphs().eight === null;
	const layout = introLayout(viewport.width, viewport.height, isRich);

	const k = motion ? collapseIndex(elapsed) : -1;
	const frame = k >= 0 ? collapseFrames(layout, isRich)[k] : undefined;
	if (frame) {
		return (
			<Box flexDirection="column" paddingTop={frame.top} paddingLeft={frame.left}>
				<Mark8 size={frame.size} rich={isRich} />
			</Box>
		);
	}

	const hint = `any key to continue${version ? ` · v${version}` : ""}`;

	return (
		<Box flexDirection="column" paddingTop={layout.top}>
			<Box paddingLeft={layout.markLeft}>
				<Mark8 size={layout.size} rich={isRich} />
			</Box>
			<Box marginTop={1} paddingLeft={layout.wordLeft}>
				<Text color={t.orange} bold>
					8
				</Text>
				<Text color={t.textPrimary} bold>
					gent
				</Text>
				<Text color={t.textTertiary}> Code</Text>
			</Box>
			<Box marginTop={1} paddingLeft={layout.blockLeft} flexDirection="column">
				{INTRO_LINES.map((line, i) => {
					const shown = typedLine(i, elapsed, motion);
					const typing = shown.length > 0 && shown.length < line.length;
					return (
						<Box key={line} width={INTRO_BLOCK_WIDTH} minHeight={1}>
							<Text color={t[INTRO_LINE_TOKENS[i] ?? "textTertiary"]} bold={i === 0}>
								{shown}
								{typing ? (isRich ? "▌" : "_") : ""}
							</Text>
						</Box>
					);
				})}
			</Box>
			<Box marginTop={1} paddingLeft={layout.blockLeft}>
				<Text color={t[INTRO_HINT_TOKEN]}>{hint}</Text>
			</Box>
		</Box>
	);
}
