/**
 * IntroBanner — animated 8GENT wordmark on TUI launch with cascade reveal.
 *
 * Sequence over ~2000ms:
 *   T+0     wordmark begins fade-in
 *   T+250   flourish rule + ∞ appears
 *   T+450   title fades in
 *   T+650   subtitle fades in
 *   T+700+  hold all elements at full brightness
 *   T+1500  fade-out begins
 *   T+1900  dismiss
 *
 * Skippable: any keypress dismisses immediately.
 * Opt-out:   set 8GENT_NO_INTRO=1 to skip entirely.
 *
 * Concept import (not code): Hermes Agent's unboxing intro. Rebuilt in
 * <120 LOC, brand amber per BRAND.md. No purple / pink / violet.
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

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
const SUBTITLE = "free. local. eight powers. no caps.";

// Reveal offsets — each element appears at its T+ms tick.
const T_WORDMARK = 0;
const T_FLOURISH = 250;
const T_TITLE = 450;
const T_SUBTITLE = 650;
const T_HOLD_END = 1500;
const T_DONE = 1900;

interface IntroBannerProps {
	onDone: () => void;
	/** Speed multiplier for tests. 0.1 = 10x faster. Default 1. */
	speed?: number;
}

export function IntroBanner({ onDone, speed = 1 }: IntroBannerProps) {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const start = performance.now();
		const tick = setInterval(() => {
			const ms = (performance.now() - start) / speed;
			setElapsed(ms);
			if (ms >= T_DONE) {
				clearInterval(tick);
				onDone();
			}
		}, 50);
		return () => clearInterval(tick);
	}, []);

	useInput(() => {
		// Any key dismisses early.
		onDone();
	});

	if (elapsed >= T_DONE) return null;

	const showFlourish = elapsed >= T_FLOURISH;
	const showTitle = elapsed >= T_TITLE;
	const showSubtitle = elapsed >= T_SUBTITLE;
	const inFadeOut = elapsed >= T_HOLD_END;

	// Each element is dim during its first 200ms of life and during the global fade-out.
	const wordmarkDim = elapsed < T_WORDMARK + 200 || inFadeOut;
	const flourishDim = !showFlourish || elapsed < T_FLOURISH + 200 || inFadeOut;
	const titleDim = !showTitle || elapsed < T_TITLE + 200 || inFadeOut;
	const subtitleDim = !showSubtitle || elapsed < T_SUBTITLE + 200 || inFadeOut;

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
				<Text color="cyan" bold dimColor={titleDim}>
					{showTitle ? TITLE : ""}
				</Text>
			</Box>
			<Box marginTop={0} minHeight={1}>
				<Text dimColor={!showSubtitle || subtitleDim}>{showSubtitle ? SUBTITLE : ""}</Text>
			</Box>
			{!inFadeOut && elapsed > T_SUBTITLE + 300 && (
				<Box marginTop={1}>
					<Text dimColor>press any key to skip</Text>
				</Box>
			)}
		</Box>
	);
}
