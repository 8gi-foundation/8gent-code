/**
 * IntroBanner — animated 8GENT wordmark on TUI launch.
 *
 * Three phases over ~1500ms:
 *   1. fade-in   (0-300ms)   — block letters appear, dim -> bright
 *   2. hold      (300-1100ms) — full brightness, brand amber, sub-line shows
 *   3. fade-out  (1100-1500ms) — dim back, then dismiss
 *
 * Skippable: any keypress dismisses immediately.
 *
 * Concept import (not code): Hermes Agent's "unboxing" intro where the
 * wordmark animates in then minimises into the header. Rebuilt in <100 LOC,
 * brand amber per BRAND.md. No purple / pink / violet (banned hues 270-350).
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

// Block-letter "8GENT" - 5 rows tall, fits in ~46 cols.
// Hand-drawn so it stays sharp even on terminals that don't kern Unicode boxes.
const BANNER_LINES: readonly string[] = [
	" ▄▄▄▄    ▄▄▄▄▄  ▄▄▄▄▄  ▄▄▄ ▄▄  ▄▄▄▄▄▄ ",
	"▐▌  ▐▌  ▐▌      ▐▌     ▐▌▀▄ ▐▌   ▐▌   ",
	" ▀▀▄▀    ▐▌ ▀▀  ▐▀▀▀   ▐▌ ▀▄▐▌   ▐▌   ",
	"▐▌  ▐▌  ▐▌  ▐▌  ▐▌     ▐▌  ▀▐▌   ▐▌   ",
	" ▀▀▀▀    ▀▀▀▀▀  ▀▀▀▀▀  ▀▀   ▀▀   ▀▀   ",
] as const;

const TAGLINE = "The Infinite Gentleman";

type Phase = "fadeIn" | "hold" | "fadeOut" | "done";

interface IntroBannerProps {
	onDone: () => void;
	/** Override total durations for tests. Default: full 1500ms run. */
	timing?: { fadeInMs?: number; holdMs?: number; fadeOutMs?: number };
}

export function IntroBanner({ onDone, timing }: IntroBannerProps) {
	const fadeInMs = timing?.fadeInMs ?? 300;
	const holdMs = timing?.holdMs ?? 800;
	const fadeOutMs = timing?.fadeOutMs ?? 400;

	const [phase, setPhase] = useState<Phase>("fadeIn");

	useEffect(() => {
		const t1 = setTimeout(() => setPhase("hold"), fadeInMs);
		const t2 = setTimeout(() => setPhase("fadeOut"), fadeInMs + holdMs);
		const t3 = setTimeout(
			() => {
				setPhase("done");
				onDone();
			},
			fadeInMs + holdMs + fadeOutMs,
		);
		return () => {
			clearTimeout(t1);
			clearTimeout(t2);
			clearTimeout(t3);
		};
	}, []);

	useInput(() => {
		// Any key dismisses early.
		setPhase("done");
		onDone();
	});

	if (phase === "done") return null;

	// Brand amber via the closest ANSI named colors. Ink supports hex but many
	// terminals rerender hex unevenly; named colors stay legible everywhere.
	const bannerColor = phase === "hold" ? "yellow" : "yellow";
	const dim = phase === "fadeIn" || phase === "fadeOut";

	return (
		<Box flexDirection="column" alignItems="center" paddingY={1}>
			{BANNER_LINES.map((line, i) => (
				<Text key={i} color={bannerColor} bold dimColor={dim}>
					{line}
				</Text>
			))}
			<Box marginTop={1}>
				<Text color="cyan" dimColor={dim}>
					{TAGLINE}
				</Text>
			</Box>
			{phase === "hold" && (
				<Box marginTop={1}>
					<Text dimColor>press any key to skip</Text>
				</Box>
			)}
		</Box>
	);
}
