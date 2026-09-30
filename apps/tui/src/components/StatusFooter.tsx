/**
 * StatusFooter - the one-row footer (HUD system, #3238):
 *
 *   mode Planning [^Y] │ perm Guarded [⇧Tab] │ session 8m 12s      [^P] palette  [^X] plan  ...
 *
 * Rules:
 * - One home per fact. The footer holds what you set (the ^Y mode, the
 *   permission mode) and the session. The model, tokens and context live in
 *   the NOW strip; the branch lives in the header. None repeats here.
 * - A quiet, expected state is not a segment (#3130): Ask shows no perm
 *   segment, "judge ready" and "providers 3/3" show nothing, ADHD mode shows
 *   only when on, and the DJ station shows only when a track is loaded and
 *   its row is closed.
 * - Segments drop by priority when the row is too narrow, never wrap. mode
 *   and perm never drop: they are where ^Y and Shift+Tab are discoverable.
 * - Every key is a key cap: "[^Y]" after the value it changes, "[^P] palette"
 *   in the hint row. The hints fill the columns the status leaves, right-
 *   aligned, most used first; [^P] palette leads because the palette lists
 *   every command.
 * - Orange means "look here": Infinite, and a System One judge that failed
 *   to load (shell commands fail closed).
 */

import { Box, Text } from "ink";
import React from "react";
import {
	type PermissionMode,
	isPermissionMode,
} from "../../../../packages/permissions/permission-mode.js";
import {
	PERM_KEY,
	PERM_LOOK,
	permColour,
	permHeldNote,
	permToastForms,
} from "../lib/perm-modes-design.js";
import { theme } from "../theme.js";
import { KEY_CAP_GAP, KeyCap, keyCapText, splitHint } from "./KeyCap.js";

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
	/** Optional dim note between the value and the hint, e.g. "(held by parent)". */
	note?: string;
	bold?: boolean;
	color: string;
	/** 0 is kept longest. Higher numbers drop first when space runs out. */
	priority: number;
}

/** The System One judge's warm-up. Undefined: System One is off. */
export type JudgeState = "loading" | "ready" | "failed";

export interface FooterData {
	mode: string;
	tokensPerSecond?: number;
	sessionTime?: string;
	/**
	 * The focused tab's permission mode (#3170): plan, ask, guarded or
	 * infinite shows as the perm segment; any other real string prints as an
	 * "approval" segment, as before.
	 */
	permissions?: string;
	/** True when a parent agent holds this one below the mode that was set (#3174). */
	permHeld?: boolean;
	/** Terminal columns, so the held note can shorten below 120. */
	columns?: number;
	/** Live providers out of configured providers. */
	providersLive?: number;
	providersTotal?: number;
	user?: string;
	judge?: JudgeState;
	/** ADHD mode: a segment only while on (it had a rail row before #3238). */
	adhd?: boolean;
}

/** A value the app passes when it does not know the real one. */
function known(value: string | undefined): value is string {
	if (value == null) return false;
	const v = value.trim();
	return v.length > 0 && v !== "—" && v !== "-" && v !== "?";
}

export function segmentWidth(s: FooterSegment): number {
	return (
		(s.label ? s.label.length + 1 : 0) +
		s.value.length +
		(s.note ? s.note.length + 1 : 0) +
		(s.hint ? keyCapText(s.hint).length + 1 : 0)
	);
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
	const perm = isPermissionMode(d.permissions) ? d.permissions : undefined;
	// Ask shows no segment, unless a parent holds the tab there: then it says so.
	if (perm && (perm !== "ask" || d.permHeld)) {
		out.push({
			key: "perm",
			label: "perm",
			value: PERM_LOOK[perm].name,
			note: d.permHeld ? permHeldNote(d.columns ?? 160) : undefined,
			hint: PERM_KEY,
			bold: PERM_LOOK[perm].bold,
			color: permColour(perm),
			priority: 0,
		});
	}
	if (d.tokensPerSecond && d.tokensPerSecond > 0) {
		out.push({ key: "rate", value: formatTps(d.tokensPerSecond), color: ui.teal, priority: 6 });
	}
	if (!perm && known(d.permissions) && d.permissions !== "ask") {
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
	if (d.judge && d.judge !== "ready") {
		out.push({
			key: "judge",
			label: "judge",
			value: d.judge,
			color: d.judge === "failed" ? ui.orange : ui.muted,
			priority: 1,
		});
	}
	if (
		d.providersTotal != null &&
		d.providersTotal > 0 &&
		d.providersLive != null &&
		d.providersLive < d.providersTotal
	) {
		out.push({
			key: "providers",
			label: "providers",
			value: `${d.providersLive}/${d.providersTotal}`,
			color: ui.cream,
			priority: 5,
		});
	}
	if (d.adhd) {
		out.push({ key: "adhd", label: "adhd", value: "on", color: ui.teal, priority: 3 });
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
 * Columns a row of segments takes. Segments are joined by the separator;
 * `leading` adds one before the first, for when the DJ station segment is
 * drawn ahead of them.
 */
export function segmentsWidth(segments: FooterSegment[], leading = false): number {
	if (segments.length === 0) return 0;
	const seps = segments.length - 1 + (leading ? 1 : 0);
	return segments.reduce((sum, s) => sum + segmentWidth(s), 0) + seps * FOOTER_SEPARATOR.length;
}

/**
 * Keep as many segments as fit in `width` columns, dropping the highest
 * priority number first. Display order is preserved. The priority-0
 * segments are always kept, even if they alone overflow (Ink truncates the
 * row).
 */
export function fitFooterSegments(
	segments: FooterSegment[],
	width: number,
	leading = false,
): FooterSegment[] {
	const kept = [...segments];
	while (segmentsWidth(kept, leading) > width) {
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

/** Columns kept on the left for the DJ station segment, when DjDeck draws
 *  one (a track is loaded and its row is closed). */
export function fmSegmentWidth(columns: number): number {
	return columns >= 120 ? 22 : 10;
}

/**
 * The key hints, most used first; display order is the same. [^P] palette
 * leads: the palette lists every command, so at 80 columns it is the one
 * hint that stays. Ctrl+C saves the session and quits (app.tsx), so it says
 * quit, not clear.
 */
export const FOOTER_HINTS = [
	"^P palette",
	"^X plan",
	// Ask has no perm segment, so the switch key is taught here instead.
	`${PERM_KEY} perm`,
	"^O expand",
	"^K kanban",
	"^B processes",
	"^D DJ",
	"^A anim",
	"^S sound",
	"^C quit",
];
/** Columns kept between the last status segment and the first hint. */
const HINTS_MARGIN = 3;

/** Columns one hint takes as a key cap: "[^X] plan". */
export function hintWidth(hint: string): number {
	const { cap, verb } = splitHint(hint);
	return keyCapText(cap, verb).length;
}

/** The hints that fit in `width` columns, most used first, never cut. */
export function fitFooterHints(width: number, permShown = false): string[] {
	const out: string[] = [];
	let used = 0;
	for (const hint of FOOTER_HINTS) {
		// The perm segment already shows the key.
		if (permShown && hint.endsWith(" perm")) continue;
		const cost = hintWidth(hint) + (out.length > 0 ? KEY_CAP_GAP.length : 0);
		if (used + cost > width) break;
		out.push(hint);
		used += cost;
	}
	return out;
}

/** A permission switch the footer is announcing (#3174). */
export interface FooterToast {
	mode: PermissionMode;
	held: boolean;
}

/**
 * Fit the toast into the hints slot: the longest of full / short / tiny that
 * fits. Full and short keep every priority 0-1 segment that shows without
 * the toast; tiny keeps priority 0 (mode and perm), which at 80 columns
 * always leaves room for it. Lower segments step aside while it shows. Null
 * when nothing fits: the perm segment already names the mode.
 */
export function fitFooterToast(
	all: FooterSegment[],
	width: number,
	toast: FooterToast,
	leading = false,
): { text: string; segments: FooterSegment[] } | null {
	const forms = permToastForms(toast.mode, toast.held);
	const plain = fitFooterSegments(all, width, leading);
	const mustKeep = (s: FooterSegment[], max: number) =>
		plain.filter((p) => p.priority <= max).every((p) => s.includes(p));
	for (const [text, keepUpTo] of [
		[forms.full, 1],
		[forms.short, 1],
		[forms.tiny, 0],
	] as const) {
		const room = width - text.length - HINTS_MARGIN;
		if (room <= 0) continue;
		const fitted = fitFooterSegments(all, room, leading);
		if (segmentsWidth(fitted, leading) <= room && mustKeep(fitted, keepUpTo)) {
			return { text, segments: fitted };
		}
	}
	return null;
}

export function StatusSegments({
	data,
	width,
	toast,
	leading = false,
}: {
	data: FooterData;
	width: number;
	toast?: FooterToast | null;
	/** The DJ station segment is drawn before this row: start with a separator. */
	leading?: boolean;
}) {
	const all = buildFooterSegments(data);
	const toastFit = toast ? fitFooterToast(all, width, toast, leading) : null;
	const segments = toastFit ? toastFit.segments : fitFooterSegments(all, width, leading);
	const hints = toastFit
		? []
		: fitFooterHints(
				Math.max(0, width - segmentsWidth(segments, leading) - HINTS_MARGIN),
				segments.some((s) => s.key === "perm"),
			);
	return (
		// One column clear of the right edge, like the chips in the header (#3238).
		<Box flexGrow={1} minWidth={0} overflow="hidden" justifyContent="space-between" marginRight={1}>
			<Text wrap="truncate-end">
				{segments.map((s, i) => (
					<React.Fragment key={s.key}>
						{i > 0 || leading ? <Text color={ui.dim}>{FOOTER_SEPARATOR}</Text> : null}
						{s.label ? <Text color={ui.muted}>{s.label} </Text> : null}
						<Text color={s.color} bold={s.bold}>
							{s.value}
						</Text>
						{s.note ? <Text color={ui.muted}> {s.note}</Text> : null}
						{s.hint ? (
							<Text>
								{" "}
								<KeyCap cap={s.hint} />
							</Text>
						) : null}
					</React.Fragment>
				))}
			</Text>
			{toastFit && toast ? (
				<Box flexShrink={0}>
					<Text color={permColour(toast.mode)} bold={PERM_LOOK[toast.mode].bold}>
						{toastFit.text}
					</Text>
				</Box>
			) : null}
			{hints.length > 0 ? (
				<Box flexShrink={0}>
					<Text>
						{hints.map((h, i) => {
							const { cap, verb } = splitHint(h);
							return (
								<Text key={h}>
									{i > 0 ? KEY_CAP_GAP : ""}
									<KeyCap cap={cap} verb={verb} />
								</Text>
							);
						})}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
