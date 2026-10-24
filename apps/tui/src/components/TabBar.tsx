/**
 * 8gent Code - Tab Bar Component
 *
 * Numbered tabs with an underline, from the chat-first design (mockup A):
 *
 *   1] Orchestrator   2] Engineer   3] QA   4] Notes
 *   ───━━━━━━━━━━━━──────────────────────────────────────
 *
 * The active title is bold primary text, and an orange bar sits under it on
 * the rule row. Orange has one other job on this bar: the lamp of a tab that
 * needs you.
 *
 * Tab lamps (#4928): one still mark after each title (and after its permission
 * tag), from lib/tab-lamps.ts. An idle tab is dark: no mark at rest.
 *
 *   1] Orchestrator ◐   2] Engineer   3] QA · Plan ▲   4] Notes ●
 *
 * Below 60 columns the titles give way and the lamps never do; the active
 * tab keeps its title: "[1 Orchestrator ◐] 2 3▲ 4●". Tabs that do not fit
 * collapse into "+2 ▲", carrying the most urgent hidden lamp. When the active tab changes, the bar sweeps from the old
 * title to the new one in four frames (lib/motion.ts). The labels never
 * move. With animations off (Ctrl+A) or reduced motion, the bar jumps.
 *
 * Permission modes (#3174): a tab whose mode is not Ask carries it after
 * its title, in the mode's colour, outside the underline:
 *
 *   1] Orchestrator · Guarded   2] Engineer   3] QA · Plan
 *
 * At 120 columns or more the tag is the word; below, one glyph (P, G, ∞).
 *
 * Pane grouping support: tabs in the same group carry a "+", and a grabbed
 * tab (Ctrl+G drag mode) is wrapped in [ ]. The drop hint shows only while
 * a tab is actually grabbed.
 */

import { Box, Text, useStdout } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { PaneGroup } from "../hooks/usePaneGroups.js";
import type { WorkspaceTab } from "../hooks/useWorkspaceTabs.js";
import { type ClickSpan, useClickSpans, usePressedIn } from "../lib/click-targets.js";
import { cellWidth } from "../lib/header-layout.js";
import { SWEEP_FRAME_MS, type Span, motionEnabled, sweepFrames } from "../lib/motion.js";
import {
	PERM_LOOK,
	type PermView,
	TAB_TAG_WIDE_COLS,
	permColour,
	permTabTag,
} from "../lib/perm-modes-design.js";
import {
	type LampFrame,
	type LampInput,
	type LampState,
	type LampTone,
	barAriaLabel,
	deriveLamp,
	lampGlyph,
	lampTransition,
	restFrame,
	worstLamp,
} from "../lib/tab-lamps.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";

// Strip external-AI-vendor names from existing-session tab titles at render
// time. Persisted sessions still carry the old "Claude Code" string; this
// rewrites them on the fly so we never expose vendor names to the user.
function sanitizeTabTitle(title: string): string {
	if (title === "Claude Code") return "Sparring";
	if (title.toLowerCase().includes("claude")) return "Peer";
	return title;
}

interface TabBarProps {
	tabs: WorkspaceTab[];
	onSwitch: (tabId: string) => void;
	/**
	 * Optional predicate. Returning true marks a tab as currently processing
	 * (in-flight chat call). The tab's lamp reads "working" so the user
	 * can see at a glance which tabs are still busy while looking at another.
	 */
	isTabProcessing?: (tabId: string) => boolean;
	/**
	 * What a tab's lamp needs beyond "processing": an approval waiting on it,
	 * and a turn that ended while it was in the background.
	 */
	lampFor?: (tabId: string) => Pick<LampInput, "needsYou" | "unread"> | undefined;
	/** Pane groups for showing tab groupings */
	groups?: PaneGroup[];
	/** Currently grabbed tab (in drag mode). Omitted or null = not dragging. */
	grabbedTabId?: string | null;
	/** Called when user presses Ctrl+G on a tab */
	onGrabTab?: (tabId: string) => void;
	/** Called when user presses Ctrl+G on a tab (drop) */
	onDropOntoTab?: (targetTabId: string) => void;
	/** False (Ctrl+A) draws the underline in its final place, no sweep. */
	animate?: boolean;
	/** Each tab's permission mode (#3174); undefined for tabs that run no agent. */
	permFor?: (tabId: string) => PermView | undefined;
	/** Columns to lay out in; defaults to the terminal's. */
	width?: number;
}

export const GRAB_HINT = "[^G] drop on another tab to group  [Esc] cancel";
const GAP = "   ";
/** Below this many columns the titles give way and the lamps stay. */
export const COMPACT_COLS = 60;
const COMPACT_GAP = " ";

/** Theme colour for each lamp tone. Orange is only ever the needs-you lamp. */
const TONE_COLOUR: Record<LampTone, string> = {
	dim: t.textTertiary,
	secondary: t.textSecondary,
	orange: t.orange,
	green: t.green,
	red: t.red,
};

export interface TabCell {
	/** "1] " style prefix, drawn dim. */
	num: string;
	title: string;
	active: boolean;
	grabbed?: boolean;
	/** Permission tag after the title, e.g. " · Guarded". Never underlined. */
	tag?: string;
	tagColor?: string;
	tagBold?: boolean;
	/** The lamp glyph, drawn after the title. */
	lamp?: string;
	lampFrame?: LampFrame;
	/** Closes a compact active tab: "[1 Title ◐]". */
	close?: string;
}

export interface TabLine {
	/** Plain text of the label row, for width checks and tests. */
	text: string;
	/** Column and width of each cell's title, in `cells` order. */
	spans: Span[];
}

/**
 * Each cell's whole span on the label row (number, title, tag, grab
 * brackets), for clicks (#3239). Measured in terminal cells, so a title
 * with wide characters keeps its clickable edge where it is drawn.
 */
export function cellSpans(cells: TabCell[], gap = GAP): Span[] {
	let x = 0;
	return cells.map((cell, i) => {
		if (i > 0) x += gap.length;
		const w =
			(cell.grabbed ? 2 : 0) +
			cellWidth(cell.num) +
			cellWidth(cell.title) +
			lampWidth(cell) +
			(cell.tag ? cellWidth(cell.tag) : 0) +
			(cell.close ? cellWidth(cell.close) : 0);
		const span = { x, width: w };
		x += w;
		return span;
	});
}

/** The lamp and the space before it (none when there is no title to space from). */
function lampWidth(cell: TabCell): number {
	return cell.lamp ? (cell.title || cell.tag ? 1 : 0) + cellWidth(cell.lamp) : 0;
}

/** Lay the cells out on one row. Pure, so the geometry can be tested. */
export function layoutTabs(cells: TabCell[], gap = GAP): TabLine {
	let text = "";
	const spans: Span[] = [];
	cells.forEach((cell, i) => {
		if (i > 0) text += gap;
		if (cell.grabbed) text += "[";
		text += cell.num;
		// Cells, not code units: the underline sits under what is drawn.
		spans.push({ x: cellWidth(text), width: cellWidth(cell.title) });
		text += cell.title;
		if (cell.tag) text += cell.tag;
		if (cell.lamp) text += (cell.title || cell.tag ? " " : "") + cell.lamp;
		if (cell.close) text += cell.close;
		if (cell.grabbed) text += "]";
	});
	return { text, spans };
}

export interface FittedTabs {
	/** Cells to draw, the overflow cell last when tabs were cut. */
	cells: TabCell[];
	/** Tab index (into the input) of each drawn cell; null for the overflow cell. */
	index: (number | null)[];
	/** Input indexes of the tabs that did not fit. */
	hidden: number[];
}

/**
 * Fit the cells into `width`. Tabs are cut from the far end, never the active
 * one, and the cut tabs collapse into one "+N" cell that carries the most
 * urgent hidden lamp, so an ask is never hidden.
 */
export function fitTabCells(
	cells: TabCell[],
	states: LampState[],
	width: number,
	gap = GAP,
	ascii = false,
): FittedTabs {
	const all = cells.map((_, i) => i);
	const measure = (list: TabCell[]) => {
		const spans = cellSpans(list, gap);
		const end = spans.at(-1);
		return end ? end.x + end.width : 0;
	};
	if (measure(cells) <= width) return { cells, index: all, hidden: [] };
	const cuttable = all.filter((i) => !cells[i]?.active).reverse();
	let best: FittedTabs | null = null;
	for (let k = 1; k <= cuttable.length; k++) {
		const hidden = cuttable.slice(0, k).sort((a, b) => a - b);
		const kept = all.filter((i) => !hidden.includes(i));
		const worst = restFrame(worstLamp(hidden.map((i) => states[i] ?? "idle")));
		const more: TabCell = {
			num: `+${hidden.length}`,
			title: "",
			active: false,
			lamp: lampGlyph(worst, ascii),
			lampFrame: worst,
		};
		const out = [...kept.map((i) => cells[i] as TabCell), more];
		best = { cells: out, index: [...kept, null], hidden };
		if (measure(out) <= width) break;
	}
	return best ?? { cells, index: all, hidden: [] };
}

let liveLampTimers = 0;
/** Timers the lamps hold right now. Test-only: it must return to zero. */
export function _lampTimersLive(): number {
	return liveLampTimers;
}

interface LampRun {
	to: LampState;
	frames: LampFrame[];
	i: number;
}

/**
 * The frame each tab's lamp draws. A change plays once (lib/tab-lamps.ts) and
 * rests; nothing loops, and with motion off the final frame is drawn at once.
 * The first render after a change already shows the new state's lead frame,
 * so a change is never a render late.
 */
function useLampFrames(
	states: Record<string, LampState>,
	activeId: string | null,
	animate: boolean,
): Record<string, LampFrame> {
	const [runs, setRuns] = useState<Record<string, LampRun>>({});
	const seen = useRef<Record<string, LampState>>({});
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const animateRef = useRef(animate);
	animateRef.current = animate;
	const activeRef = useRef(activeId);
	activeRef.current = activeId;

	const stateKey = Object.entries(states)
		.map(([id, s]) => `${id}=${s}`)
		.join(",");
	useEffect(() => {
		const clear = (id: string) => {
			const h = timers.current.get(id);
			if (h !== undefined) {
				clearTimeout(h);
				timers.current.delete(id);
				liveLampTimers -= 1;
			}
		};
		for (const [id, to] of Object.entries(states)) {
			const from = seen.current[id];
			seen.current[id] = to;
			if (from === undefined || from === to) continue;
			clear(id);
			const frames = lampTransition(from, to, { visited: id === activeRef.current });
			if (frames.length <= 1 || !motionEnabled(animateRef.current)) {
				setRuns((r) => {
					if (!(id in r)) return r;
					const { [id]: _gone, ...rest } = r;
					return rest;
				});
				continue;
			}
			const step = (i: number) => {
				setRuns((r) => ({ ...r, [id]: { to, frames, i } }));
				const f = frames[i];
				if (!f || f.ms <= 0 || i >= frames.length - 1) return;
				liveLampTimers += 1;
				timers.current.set(
					id,
					setTimeout(() => {
						liveLampTimers -= 1;
						timers.current.delete(id);
						step(i + 1);
					}, f.ms),
				);
			};
			step(0);
		}
	}, [stateKey]);

	useEffect(
		() => () => {
			for (const h of timers.current.values()) {
				clearTimeout(h);
				liveLampTimers -= 1;
			}
			timers.current.clear();
		},
		[],
	);

	const out: Record<string, LampFrame> = {};
	for (const [id, s] of Object.entries(states)) {
		const active = id === activeId;
		const run = runs[id];
		const prev = seen.current[id];
		if (run && run.to === s && run.i < run.frames.length - 1) {
			out[id] = run.frames[run.i] ?? restFrame(s, active);
		} else if (prev !== undefined && prev !== s && motionEnabled(animate)) {
			// Changed this render; the effect has not started it yet.
			out[id] = lampTransition(prev, s, { visited: active })[0] ?? restFrame(s, active);
		} else {
			out[id] = restFrame(s, active);
		}
	}
	return out;
}

/** The rule row: dim rule with the bar at `bar`, exactly `width` columns. */
export function ruleRow(
	width: number,
	bar: Span | null,
	g = glyphs(),
): { before: string; bar: string; after: string } {
	const w0 = Math.max(0, width);
	if (!bar) return { before: g.rule.repeat(w0), bar: "", after: "" };
	const x = Math.max(0, Math.min(w0, bar.x));
	const w = Math.max(0, Math.min(w0 - x, bar.width));
	return { before: g.rule.repeat(x), bar: g.bar.repeat(w), after: g.rule.repeat(w0 - x - w) };
}

export function TabBar({
	tabs,
	onSwitch,
	isTabProcessing,
	lampFor,
	groups = [],
	grabbedTabId = null,
	animate = true,
	permFor,
	width: widthProp,
}: TabBarProps) {
	const { stdout } = useStdout();
	const width = widthProp ?? stdout?.columns ?? 80;
	const visibleTabs = tabs.filter((tab) => tab.type !== "kanban" || tab.active);
	const dragging = grabbedTabId !== null && grabbedTabId !== undefined;

	const ascii = glyphs().rule === "-";
	const compact = width < COMPACT_COLS;
	const gap = compact ? COMPACT_GAP : GAP;
	const states: Record<string, LampState> = {};
	for (const tab of visibleTabs) {
		const flags = lampFor?.(tab.id);
		states[tab.id] = deriveLamp({
			processing: Boolean(isTabProcessing?.(tab.id)),
			needsYou: flags?.needsYou ?? false,
			unread: flags?.unread ?? null,
		});
	}
	const activeTab = visibleTabs.find((tab) => tab.active);
	const lampFrames = useLampFrames(states, activeTab?.id ?? null, animate);

	const fullCells: TabCell[] = visibleTabs.map((tab, i) => {
		const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";
		const grouped = groups.some((g) => g.tabIds.includes(tab.id)) ? " +" : "";
		const perm = permFor?.(tab.id);
		const tag =
			perm && (!compact || tab.active) ? permTabTag(perm, width >= TAB_TAG_WIDE_COLS) : "";
		const frame = lampFrames[tab.id] ?? restFrame("idle");
		const shape = compact
			? tab.active
				? { num: `[${i + 1} `, close: "]" }
				: { num: `${i + 1}` }
			: { num: `${i + 1}] ` };
		return {
			...shape,
			title: compact && !tab.active ? "" : `${sanitizeTabTitle(tab.title)}${badge}${grouped}`,
			active: tab.active,
			grabbed: dragging && grabbedTabId === tab.id,
			// An idle tab is dark: no glyph at rest. The lamp comes after the
			// permission tag, so its mark never sits beside the tag's own " · ".
			...(states[tab.id] === "idle" && frame.ms === 0
				? {}
				: { lamp: lampGlyph(frame, ascii), lampFrame: frame }),
			...(perm && tag
				? { tag, tagColor: permColour(perm.mode), tagBold: PERM_LOOK[perm.mode].bold }
				: {}),
		};
	});
	const fitted = fitTabCells(
		fullCells,
		visibleTabs.map((tab) => states[tab.id] ?? "idle"),
		width,
		gap,
		ascii,
	);
	const cells = fitted.cells;
	const idAt = (i: number): string | null => {
		const k = fitted.index[i];
		return k === null || k === undefined ? null : (visibleTabs[k]?.id ?? null);
	};
	const ariaLabel = barAriaLabel(
		visibleTabs.map((tab) => ({
			title: sanitizeTabTitle(tab.title),
			state: states[tab.id] ?? "idle",
		})),
	);
	const line = layoutTabs(cells, gap);
	const activeIndex = cells.findIndex((c) => c.active);
	const target = activeIndex >= 0 ? (line.spans[activeIndex] ?? null) : null;
	const targetKey = target ? `${target.x}:${target.width}` : "none";

	// The bar's drawn position. It differs from `target` only during a sweep.
	const [bar, setBar] = useState<Span | null>(target);
	const barRef = useRef<Span | null>(target);
	barRef.current = bar;
	const animateRef = useRef(animate);
	animateRef.current = animate;

	// Keyed on targetKey (the value of target), so a re-render with the same tab never restarts a sweep.
	useEffect(() => {
		const from = barRef.current;
		const same = from && target && from.x === target.x && from.width === target.width;
		if (!target || !from || same || !motionEnabled(animateRef.current)) {
			setBar(target);
			return;
		}
		// Start from wherever the bar is now, so a switch mid-sweep never jumps back.
		const frames = sweepFrames(from, target);
		let i = 0;
		setBar(frames[0] ?? target);
		const id = setInterval(() => {
			i += 1;
			if (i >= frames.length) {
				clearInterval(id);
				return;
			}
			setBar(frames[i] ?? target);
		}, SWEEP_FRAME_MS);
		return () => clearInterval(id);
	}, [targetKey]);

	// A click on a tab switches to it, as its number key does (#3239). Two
	// rows: the label and the underline under it are one target.
	const labelRef = useRef(null);
	// The "+N" cell jumps to the most urgent hidden tab, so a hidden ask is one tap away.
	const hiddenTarget = (): string | null => {
		const ids = fitted.hidden.map((k) => visibleTabs[k]?.id).filter((x): x is string => !!x);
		return ids.find((id) => states[id] === "needs") ?? ids[0] ?? null;
	};
	const clickSpans: ClickSpan[] = cellSpans(cells, gap).map((span, i) => {
		const id = idAt(i) ?? "more";
		return {
			id: `tab:${id}`,
			dx: span.x,
			w: span.width,
			h: 2,
			action: () => {
				const to = idAt(i) ?? hiddenTarget();
				if (to) onSwitch(to);
			},
		};
	});
	useClickSpans(labelRef, tabs.length <= 1 ? [] : clickSpans);
	const pressed = usePressedIn("tab:");

	if (tabs.length <= 1) return null;

	const hint = dragging ? ` ${GRAB_HINT}` : "";
	const rule = ruleRow(width, bar);

	return (
		<Box flexDirection="column" marginBottom={0} flexShrink={0}>
			<Box>
				<Box ref={labelRef} flexGrow={1} minWidth={0}>
					<Text wrap="truncate-end" aria-label={ariaLabel}>
						{cells.map((cell, i) => {
							const id = idAt(i) ?? "more";
							const lf = cell.lampFrame;
							return (
								<React.Fragment key={id}>
									{i > 0 ? gap : ""}
									{cell.grabbed ? <Text color={t.orange}>[</Text> : null}
									<Text color={t.textTertiary}>{cell.num}</Text>
									{cell.title ? (
										<Text
											color={cell.active ? t.textPrimary : t.muted}
											bold={cell.active}
											inverse={pressed === `tab:${id}`}
										>
											{cell.title}
										</Text>
									) : null}
									{cell.tag ? (
										<Text color={cell.tagColor} bold={cell.tagBold}>
											{cell.tag}
										</Text>
									) : null}
									{cell.lamp && lf ? (
										<Text
											color={TONE_COLOUR[lf.tone]}
											bold={lf.bold}
											inverse={lf.inverse || (!cell.title && pressed === `tab:${id}`)}
										>
											{(cell.title || cell.tag ? " " : "") + cell.lamp}
										</Text>
									) : null}
									{cell.close ? <Text color={t.textTertiary}>{cell.close}</Text> : null}
									{cell.grabbed ? <Text color={t.orange}>]</Text> : null}
								</React.Fragment>
							);
						})}
					</Text>
				</Box>
				{hint ? <Text color={t.orange}>{hint}</Text> : null}
			</Box>
			<Text wrap="truncate-end">
				<Text color={t.dim}>{rule.before}</Text>
				<Text color={t.orange}>{rule.bar}</Text>
				<Text color={t.dim}>{rule.after}</Text>
			</Text>
		</Box>
	);
}
