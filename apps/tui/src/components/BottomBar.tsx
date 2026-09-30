/**
 * BottomBar - single-render wrapper for the bottom of the chat screen.
 *
 * One footer row (8GENT FM | mode | model | tokens | branch | session ...)
 * plus the keyboard hint row, following the chat-first design (mockup A).
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
import { FooterHints, type JudgeState, StatusSegments, fmSegmentWidth } from "./StatusFooter.js";

export type FooterMode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";

interface BottomBarProps {
	model: string;
	/** Live providers out of configured providers. */
	ready: number;
	total: number;
	tokens: string;
	branch?: string;
	/** Optional auth display-name override; falls back to the OS user. (#2366) */
	user?: string;
	permissions: string;
	sessionTime: string;
	mode: FooterMode;
	/** When true, the FM segment says "agent pulse" instead of "idle" so the
	 *  bottom heartbeat reflects the live turn. */
	isProcessing?: boolean;
	/** Smoothed output tokens-per-second from the most recent agent step.
	 *  0/undefined hides the indicator. */
	tokensPerSecond?: number;
	/** System One judge warm-up; undefined when System One is off. */
	judge?: JudgeState;
}

function resolveUser(override?: string): string | undefined {
	if (override && override.trim().length > 0) return override;
	const fromEnv = process.env.USER || process.env.LOGNAME;
	return fromEnv && fromEnv.trim().length > 0 ? fromEnv : undefined;
}

export function BottomBar(props: BottomBarProps) {
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;
	const fmWidth = fmSegmentWidth(columns);
	// One column of slack so a full row never triggers a terminal wrap.
	const segmentsWidth = Math.max(0, columns - fmWidth - 1);
	return (
		<Box flexDirection="column" width="100%" flexShrink={0}>
			<DjDeck
				isProcessing={props.isProcessing}
				fmWidth={fmWidth}
				footer={
					<StatusSegments
						width={segmentsWidth}
						data={{
							mode: props.mode,
							model: props.model,
							tokens: props.tokens,
							tokensPerSecond: props.tokensPerSecond,
							branch: props.branch,
							sessionTime: props.sessionTime,
							permissions: props.permissions,
							providersLive: props.ready,
							providersTotal: props.total,
							user: resolveUser(props.user),
							judge: props.judge,
						}}
					/>
				}
			/>
			<FooterHints />
		</Box>
	);
}
