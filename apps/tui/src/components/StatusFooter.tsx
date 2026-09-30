/**
 * StatusFooter - the one-row footer from the chat-first design (mockup A):
 *
 *   ● 8GENT FM idle │ mode Planning ^Y │ model qwen3.8:27b │ tokens 179K tok │ branch main │ session 8m 12s
 *
 * It replaces three stacked blocks that took 11 rows between them: the
 * bordered 8GENT FM bar, the seven bordered MODEL/AGENTS/TOKENS/... tiles
 * and the bordered PLANNING/RESEARCH/... mode strip.
 *
 * Rules:
 * - Segments drop by priority when the row is too narrow, never wrap. The
 *   mode segment never drops, because it is where ^Y is discoverable.
 * - A value that is not known is not shown. No "—", no "?", no "Guest".
 * - The ^Y mode is labelled MODE: it is the manual prompt mode the user
 *   picks, not a pipeline phase, so it is never dressed up as progress.
 * - Orange means "look here": the infinite approval state, and a System
 *   One judge that failed to load (shell commands fail closed).
 * - The judge's warm-up is status, so it shows here, never as a chat line
 *   (#3090): "judge loading", then "judge ready". Loading and failed are
 *   kept when space is short; ready is the quiet state and drops first.
 */

import { Box, Text, useStdout } from "ink";
import React from "react";
import { theme } from "../theme.js";

const ui = {
	muted: theme.color.muted,
	dim: theme.color.dim,
	cream: theme.color.cream,
	teal: theme.color.teal,
	orange: theme.color.orange,
} as const;

export const FOOTER_SEPARATOR = " │ ";

export interface FooterSegment {
	key: string;
	/** Dim lower-case label before the value, e.g. "model". */
	label?: string;
	value: string;
	/** Optional dim suffix after the value, e.g. the "^Y" key hint. */
	hint?: string;
	color: string;
	/** 0 is kept longest. Higher numbers drop first when space runs out. */
	priority: number;
}

/** The System One judge's warm-up. Undefined: System One is off. */
export type JudgeState = "loading" | "ready" | "failed";

export interface FooterData {
	mode: string;
	model?: string;
	tokens?: string;
	tokensPerSecond?: number;
	branch?: string;
	sessionTime?: string;
	/** "ask" or "infinite" today; any other real mode string prints as is. */
	permissions?: string;
	/** Live providers out of configured providers. */
	providersLive?: number;
	providersTotal?: number;
	user?: string;
	judge?: JudgeState;
}

/** A value the app passes when it does not know the real one. */
function known(value: string | undefined): value is string {
	if (value == null) return false;
	const v = value.trim();
	return v.length > 0 && v !== "—" && v !== "-" && v !== "?";
}

export function segmentWidth(s: FooterSegment): number {
	return (s.label ? s.label.length + 1 : 0) + s.value.length + (s.hint ? s.hint.length + 1 : 0);
}

function truncateMiddle(value: string, max: number): string {
	if (value.length <= max) return value;
	const keep = max - 1;
	const left = Math.ceil(keep * 0.55);
	const right = Math.floor(keep * 0.45);
	return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function formatTps(tps: number): string {
	if (tps >= 100) return `${Math.round(tps)} t/s`;
	if (tps >= 10) return `${tps.toFixed(0)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

/** Build every segment we have real data for, in display order. */
export function buildFooterSegments(d: FooterData): FooterSegment[] {
	const out: FooterSegment[] = [
		{ key: "mode", label: "mode", value: d.mode, hint: "^Y", color: ui.teal, priority: 0 },
	];
	if (known(d.model)) {
		out.push({ key: "model", label: "model", value: truncateMiddle(d.model, 24), color: ui.cream, priority: 1 });
	}
	if (known(d.tokens)) {
		out.push({ key: "tokens", label: "tokens", value: d.tokens, color: ui.cream, priority: 2 });
	}
	if (d.tokensPerSecond && d.tokensPerSecond > 0) {
		out.push({ key: "rate", value: formatTps(d.tokensPerSecond), color: ui.teal, priority: 6 });
	}
	if (known(d.branch)) {
		out.push({ key: "branch", label: "branch", value: d.branch, color: ui.cream, priority: 3 });
	}
	if (known(d.permissions)) {
		const infinite = d.permissions === "infinite";
		out.push({
			key: "approval",
			label: "approval",
			value: d.permissions,
			color: infinite ? ui.orange : ui.cream,
			// Running without asking is the state a person must not miss.
			priority: infinite ? 1 : 5,
		});
	}
	if (d.judge) {
		out.push({
			key: "judge",
			label: "judge",
			value: d.judge,
			color: d.judge === "failed" ? ui.orange : d.judge === "loading" ? ui.muted : ui.cream,
			priority: d.judge === "ready" ? 6 : 1,
		});
	}
	if (d.providersTotal != null && d.providersTotal > 0 && d.providersLive != null) {
		out.push({
			key: "providers",
			label: "providers",
			value: `${d.providersLive}/${d.providersTotal}`,
			color: ui.cream,
			priority: 6,
		});
	}
	if (known(d.user)) {
		out.push({ key: "user", label: "user", value: d.user, color: ui.cream, priority: 7 });
	}
	if (known(d.sessionTime)) {
		out.push({ key: "session", label: "session", value: d.sessionTime, color: ui.muted, priority: 4 });
	}
	return out;
}

/**
 * Keep as many segments as fit in `width` columns, dropping the highest
 * priority number first. Every segment is drawn after a separator, because
 * the row starts with the 8GENT FM segment. Display order is preserved. The
 * priority-0 segment is always kept, even if it alone overflows (Ink
 * truncates the row).
 */
export function fitFooterSegments(segments: FooterSegment[], width: number): FooterSegment[] {
	const kept = [...segments];
	const total = () =>
		kept.reduce((sum, s) => sum + segmentWidth(s) + FOOTER_SEPARATOR.length, 0);
	while (total() > width) {
		let dropAt = -1;
		for (let i = 0; i < kept.length; i++) {
			const s = kept[i];
			if (s && s.priority > 0 && (dropAt < 0 || s.priority > (kept[dropAt]?.priority ?? -1))) dropAt = i;
		}
		if (dropAt < 0) break;
		kept.splice(dropAt, 1);
	}
	return kept;
}

/** Columns reserved on the left for the 8GENT FM segment rendered by DjDeck.
 *  22 fits "● 8GENT FM agent pulse"; below 120 columns only "● 8GENT FM". */
export function fmSegmentWidth(columns: number): number {
	return columns >= 120 ? 22 : 10;
}

export function StatusSegments({ data, width }: { data: FooterData; width: number }) {
	const segments = fitFooterSegments(buildFooterSegments(data), width);
	return (
		<Box flexGrow={1} minWidth={0} overflow="hidden">
			<Text wrap="truncate-end">
				{segments.map((s) => (
					<React.Fragment key={s.key}>
						<Text color={ui.dim}>{FOOTER_SEPARATOR}</Text>
						{s.label ? <Text color={ui.muted}>{s.label} </Text> : null}
						<Text color={s.color}>{s.value}</Text>
						{s.hint ? <Text color={ui.muted}> {s.hint}</Text> : null}
					</React.Fragment>
				))}
			</Text>
		</Box>
	);
}

/** The keyboard hint row that used to sit under the mode strip. Dropped on
 *  short terminals, where it is the first row to clip. */
export function FooterHints() {
	const { stdout } = useStdout();
	const rows = stdout?.rows ?? 40;
	if (rows < 42) return null;
	return (
		<Box justifyContent="space-between" overflow="hidden" flexShrink={0}>
			<Text color={ui.muted}>^O expand  ^B processes  ^K kanban  ^D deck  ^X plan</Text>
			<Text color={ui.muted}>^A anim  ^S sound  ^C clear</Text>
		</Box>
	);
}
