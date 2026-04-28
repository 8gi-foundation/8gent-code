/**
 * IntroBanner — cinematic 8GENT wordmark on TUI launch with cascade reveal.
 *
 * Sequence over ~8500ms (paced to the slow-starting launch instrumental):
 *   T+0      wordmark begins fade-in
 *   T+1500   flourish rule + ∞ appears
 *   T+2500   title ("The Infinite Gentleman") types in
 *   T+4000   subhead ("Your kernel for autonomous code") types in
 *   T+5800   body line ("free. local. eight powers. no caps.") types in
 *   T+7500   hold completes
 *   T+8500   dismiss
 *
 * Skippable: any keypress dismisses immediately.
 * Opt-out:   set 8GENT_NO_INTRO=1 to skip entirely.
 *
 * Audio: bundled `apps/tui/sounds/launch.mp3` is played at 65% via afplay.
 * On first run we copy the bundled file to `~/.8gent/sounds/launch.mp3` so
 * the user can swap it (or set `ui.introSound` to override the path).
 *
 * Brand amber per BRAND.md. No purple / pink / violet.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { loadSettings } from "../../../../packages/settings/index.js";

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
 * Play the launch sound once, fire-and-forget. Volume 65% via `afplay -v`.
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
		// `afplay -v` accepts a 0–255 float; 1.0 = 100%, 0.4 ≈ 40%.
		// Kept low — the launch instrumental should sit under, not over,
		// the splash text reveal and any narration we layer on later.
		const proc = spawn("afplay", ["-v", "0.4", path], {
			stdio: "ignore",
			detached: true,
		});
		proc.unref();
		proc.on("error", () => {
			/* missing afplay or denied — silently ignore */
		});
	} catch {
		// best-effort; never break the banner
	}
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
const TITLE = "The Infinite Gentleman";
const SUBHEAD = "Your kernel for autonomous code";
const BODY = "free. local. eight powers. no caps.";

// Cinematic schedule — paced to the slow-starting launch instrumental.
// Skip entirely with 8GENT_NO_INTRO=1 or 8GENT_LITE=1.
const T_WORDMARK = 0;
const T_FLOURISH = 1500;
const T_TITLE = 2500;
const T_SUBHEAD = 4000;
const T_BODY = 5800;
const T_HOLD_END = 7500;
const T_DONE = 8500;

// Typewriter speed — characters revealed per second.
const TYPE_CPS = 24;

function typedSlice(line: string, elapsed: number, startMs: number): string {
	if (elapsed < startMs) return "";
	const chars = Math.floor(((elapsed - startMs) / 1000) * TYPE_CPS);
	return line.slice(0, Math.min(chars, line.length));
}

interface IntroBannerProps {
	onDone: () => void;
	/** Speed multiplier for tests. 0.1 = 10x faster. Default 1. */
	speed?: number;
}

export function IntroBanner({ onDone, speed = 1 }: IntroBannerProps) {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		playIntroSound();
	}, []);

	useEffect(() => {
		const start = performance.now();
		const tick = setInterval(() => {
			const ms = (performance.now() - start) / speed;
			setElapsed(ms);
			if (ms >= T_DONE) {
				clearInterval(tick);
				onDone();
			}
		}, 40);
		return () => clearInterval(tick);
	}, []);

	useInput(() => {
		// Any key dismisses early.
		onDone();
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

	return (
		<Box flexDirection="column" alignItems="center" paddingY={1}>
			{BANNER_LINES.map((line, i) => (
				<Text key={i} color="yellow" bold dimColor={wordmarkDim}>
					{line}
				</Text>
			))}
			<Box marginTop={1} minHeight={1}>
				<Text color="cyan" dimColor={flourishDim}>
					{showFlourish ? FLOURISH : ""}
				</Text>
			</Box>
			<Box marginTop={1} minHeight={1}>
				<Text color="cyan" bold dimColor={inFadeOut}>
					{titleText}
					{titleTyping ? "▌" : ""}
				</Text>
			</Box>
			<Box marginTop={0} minHeight={1}>
				<Text dimColor={inFadeOut} color="yellow">
					{subheadText}
					{subheadTyping ? "▌" : ""}
				</Text>
			</Box>
			<Box marginTop={0} minHeight={1}>
				<Text dimColor>
					{bodyText}
					{bodyTyping ? "▌" : ""}
				</Text>
			</Box>
			{!inFadeOut && elapsed > T_BODY + 400 && (
				<Box marginTop={1}>
					<Text dimColor>press any key to skip</Text>
				</Box>
			)}
		</Box>
	);
}
