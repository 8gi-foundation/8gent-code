/**
 * BottomBar - single-render wrapper for the bottom of the chat screen.
 *
 * One footer row (mode | perm | session ..., then the key caps that fit),
 * with the DJ row above it while a track is loaded. The model, tokens and
 * branch live in the NOW strip and the header, not here (#3238). The hints
 * had a row of their own until #3130.
 * It replaced the bordered FM bar, the seven bordered status tiles and the
 * bordered mode strip, which took 11 rows before the hint row.
 *
 * Exists so app.tsx renders one component (`<BottomBar {...} />`)
 * instead of a long JSX block. That keeps merge conflicts in app.tsx
 * from silently clobbering the footer.
 */

import { Box, useStdout } from "ink";
import React from "react";
import { DjDeck } from "./DjDeck.js";
import {
	type FooterToast,
	type JudgeState,
	StatusSegments,
	fmSegmentWidth,
} from "./StatusFooter.js";

export type FooterMode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";

interface BottomBarProps {
	/** The DJ deck has the keyboard (^D). */
	djKeys?: boolean;
	/** The deck hands the keyboard back (stop, or nothing loaded). */
	onDjKeysDone?: () => void;
	/** Live providers out of configured providers. */
	ready: number;
	total: number;
	/** The signed-in display name, when there is one (#2366). */
	user?: string;
	permissions: string;
	/** A parent agent holds this tab below the mode that was set (#3174). */
	permHeld?: boolean;
	/** The permission switch being announced in the hints slot, if any (#3174). */
	permToast?: FooterToast | null;
	sessionTime: string;
	mode: FooterMode;
	/** ADHD mode is on: a footer segment (the context rail it lived in is gone, #3238). */
	adhd?: boolean;
	/** Smoothed output tokens-per-second from the most recent agent step.
	 *  0/undefined hides the indicator. */
	tokensPerSecond?: number;
	/** System One judge warm-up; undefined when System One is off. */
	judge?: JudgeState;
}

/** The signed-in display name (#2366). The OS login is not shown: it is the
 *  person at the keyboard, so it says nothing they act on (#3130). */
function resolveUser(override?: string): string | undefined {
	return override && override.trim().length > 0 ? override : undefined;
}

export function BottomBar(props: BottomBarProps) {
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;
	const fmWidth = fmSegmentWidth(columns);
	return (
		<Box flexDirection="column" width="100%" flexShrink={0}>
			<DjDeck
				keysActive={props.djKeys}
				onKeysDone={props.onDjKeysDone}
				fmWidth={fmWidth}
				columns={columns}
				footer={(station) => (
					<StatusSegments
						// One column of slack so a full row never triggers a terminal wrap.
						width={Math.max(0, columns - (station ? fmWidth : 0) - 1)}
						leading={station}
						toast={props.permToast}
						data={{
							mode: props.mode,
							tokensPerSecond: props.tokensPerSecond,
							sessionTime: props.sessionTime,
							permissions: props.permissions,
							permHeld: props.permHeld,
							columns,
							providersLive: props.ready,
							providersTotal: props.total,
							user: resolveUser(props.user),
							judge: props.judge,
							adhd: props.adhd,
						}}
					/>
				)}
			/>
		</Box>
	);
}
