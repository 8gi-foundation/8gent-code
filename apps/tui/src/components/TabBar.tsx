/**
 * 8gent Code - Tab Bar Component
 *
 * Numbered tabs with an underline, from the chat-first design (mockup A):
 *
 *   1] Orchestrator   2] Engineer   3] QA   4] Notes
 *   ───━━━━━━━━━━━━──────────────────────────────────────
 *
 * The active title is orange and bold, and an orange bar sits under it on
 * the rule row. When the active tab changes, the bar sweeps from the old
 * title to the new one in four frames (lib/motion.ts). The labels never
 * move. With animations off (Ctrl+A) or reduced motion, the bar jumps.
 *
 * Pane grouping support: tabs in the same group carry a "+", and a grabbed
 * tab (Ctrl+G drag mode) is wrapped in [ ]. The drop hint shows only while
 * a tab is actually grabbed.
 */

import { Box, Text, useStdout } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { PaneGroup } from "../hooks/usePaneGroups.js";
import type { WorkspaceTab } from "../hooks/useWorkspaceTabs.js";
import { SWEEP_FRAME_MS, type Span, motionEnabled, sweepFrames } from "../lib/motion.js";
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
	 * (in-flight agent.chat call). The tab gets a small inline `*` so the
	 * user can see at a glance which tabs are still working while they're
	 * looking at a different one.
	 */
	isTabProcessing?: (tabId: string) => boolean;
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
}

export const GRAB_HINT = "[G] drop on another tab to group | [Esc] cancel";
const GAP = "   ";

export interface TabCell {
	/** "1] " style prefix, drawn dim. */
	num: string;
	title: string;
	active: boolean;
	grabbed?: boolean;
}

export interface TabLine {
	/** Plain text of the label row, for width checks and tests. */
	text: string;
	/** Column and width of each cell's title, in `cells` order. */
	spans: Span[];
}

/** Lay the cells out on one row. Pure, so the geometry can be tested. */
export function layoutTabs(cells: TabCell[]): TabLine {
	let text = "";
	const spans: Span[] = [];
	cells.forEach((cell, i) => {
		if (i > 0) text += GAP;
		if (cell.grabbed) text += "[";
		text += cell.num;
		spans.push({ x: text.length, width: cell.title.length });
		text += cell.title;
		if (cell.grabbed) text += "]";
	});
	return { text, spans };
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
	isTabProcessing,
	groups = [],
	grabbedTabId = null,
	animate = true,
}: TabBarProps) {
	const { stdout } = useStdout();
	const width = stdout?.columns ?? 80;
	const visibleTabs = tabs.filter((tab) => tab.type !== "kanban" || tab.active);
	const dragging = grabbedTabId !== null && grabbedTabId !== undefined;

	const cells: TabCell[] = visibleTabs.map((tab, i) => {
		const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";
		const busy = isTabProcessing?.(tab.id) ? " *" : "";
		const grouped = groups.some((g) => g.tabIds.includes(tab.id)) ? " +" : "";
		return {
			num: `${i + 1}] `,
			title: `${sanitizeTabTitle(tab.title)}${badge}${busy}${grouped}`,
			active: tab.active,
			grabbed: dragging && grabbedTabId === tab.id,
		};
	});
	const line = layoutTabs(cells);
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

	if (tabs.length <= 1) return null;

	const hint = dragging ? ` ${GRAB_HINT}` : "";
	const rule = ruleRow(width, bar);

	return (
		<Box flexDirection="column" marginBottom={0} flexShrink={0}>
			<Box>
				<Box flexGrow={1} minWidth={0}>
					<Text wrap="truncate-end">
						{cells.map((cell, i) => (
							<React.Fragment key={visibleTabs[i]?.id ?? i}>
								{i > 0 ? GAP : ""}
								{cell.grabbed ? <Text color={t.orangeAlt}>[</Text> : null}
								<Text color={t.dim}>{cell.num}</Text>
								<Text color={cell.active ? t.orange : t.muted} bold={cell.active}>
									{cell.title}
								</Text>
								{cell.grabbed ? <Text color={t.orangeAlt}>]</Text> : null}
							</React.Fragment>
						))}
					</Text>
				</Box>
				{hint ? <Text color={t.orangeAlt}>{hint}</Text> : null}
			</Box>
			<Text wrap="truncate-end">
				<Text color={t.dim}>{rule.before}</Text>
				<Text color={t.orange}>{rule.bar}</Text>
				<Text color={t.dim}>{rule.after}</Text>
			</Text>
		</Box>
	);
}
