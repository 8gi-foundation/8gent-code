/**
 * PlanPanel - the living plan for the current turn, in the PLAN column.
 *
 *   PLAN                    2/5
 *   ✓ Read the decide package
 *   ✓ Outline the deck
 *   ⠢ Write slide 3
 *   ○ Validate routing modes
 *   ○ Save the outline
 *
 * Steps are written by the agent, never invented: they come from the plan
 * the agent writes (`PLAN:` numbered lines) and from its update_plan calls,
 * which also carry each step's status. The current step carries the
 * figure-8 spinner; done steps get a check and dim; failed steps get an x.
 * New steps land one after another (lib/motion.ts). When the turn ends, the
 * panel settles into one summary line, e.g. "5 of 5 done · 2m 10s".
 *
 * With no plan this turn the caller does not mount the panel at all, so the
 * chat gets the column back.
 */

import { Box, Text } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import { FIGURE_EIGHT_STILL } from "../lib/figure-eight.js";
import { plainInline } from "../lib/inline-markdown.js";
import { motionEnabled } from "../lib/motion.js";
import type { PlanStep } from "../lib/plan-state.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";
import { KeyCapRow } from "./KeyCap.js";
import { FigureEight } from "./figure-eight-spinner.js";
import { useLandingRows } from "./ToolTrail.js";

export interface PlanPanelProps {
	steps: ReadonlyArray<PlanStep>;
	/** True while the turn that owns this plan is still running. */
	running: boolean;
	/** Wall time of the turn in ms, shown in the settled summary. */
	elapsedMs?: number | null;
	width?: number;
	/** False (Ctrl+A) draws everything in place, no landing, still spinner. */
	animate?: boolean;
	/** Key hint for the toggle, e.g. "^X". */
	toggleHint?: string;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const r = s % 60;
	return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

/** The settled summary: only facts the steps themselves carry, packed into
 *  as few lines of `width` as fit, e.g. ["4 of 5 done · 1 failed", "2m 10s"]. */
export function planSummary(steps: ReadonlyArray<PlanStep>, elapsedMs?: number | null, width = 80): string[] {
	const done = steps.filter((s) => s.status === "done").length;
	const failed = steps.filter((s) => s.status === "failed").length;
	// Without progress reports from the agent there is nothing to count as
	// done, so the summary says what is true: the plan, not a score.
	const reported = steps.some((s) => s.status !== "pending");
	const n = steps.length;
	const parts = [reported ? `${done} of ${n} done` : `${n} ${n === 1 ? "step" : "steps"} planned`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (elapsedMs != null && elapsedMs > 0) parts.push(formatElapsed(elapsedMs));
	const lines: string[] = [];
	for (const part of parts) {
		const last = lines[lines.length - 1];
		if (last !== undefined && last.length + 3 + part.length <= width) lines[lines.length - 1] = `${last} · ${part}`;
		else lines.push(part);
	}
	return lines;
}

/**
 * A step as the column draws it: the agent's words with inline markers
 * taken out (a 24-column rail has no room for a chip, and a literal
 * backtick is noise), cut to `max` with "…".
 */
function clip(text: string, max: number): string {
	const plain = plainInline(text);
	if (max <= 1) return plain.slice(0, Math.max(0, max));
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function PlanPanel({
	steps,
	running,
	elapsedMs = null,
	width = 26,
	animate = true,
	toggleHint,
}: PlanPanelProps) {
	const g = glyphs();
	const moving = motionEnabled(animate);
	const visible = useLandingRows(steps.length, animate);
	const done = steps.filter((s) => s.status === "done").length;
	const inner = Math.max(8, width - 2);
	const textMax = inner - 2;

	return (
		<Box flexDirection="column" width={width} flexShrink={0} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={t.heading} bold>
					PLAN
				</Text>
				<Text color={t.muted}>
					{steps.some((s) => s.status !== "pending") ? `${done}/${steps.length}` : `${steps.length}`}
				</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{steps.slice(0, visible).map((step) => {
					if (step.status === "done") {
						return (
							<Text key={step.id} wrap="truncate-end">
								<Text color={t.green}>{g.ok} </Text>
								<Text color={t.muted}>{clip(step.text, textMax)}</Text>
							</Text>
						);
					}
					if (step.status === "failed") {
						return (
							<Text key={step.id} wrap="truncate-end">
								<Text color={t.red}>{g.fail} </Text>
								<Text color={t.textPrimary}>{clip(step.text, textMax)}</Text>
							</Text>
						);
					}
					if (step.status === "active") {
						return (
							<Text key={step.id} wrap="truncate-end">
								{g.eight ? (
									<Text color={t.orange}>{g.eight}</Text>
								) : running ? (
									<FigureEight color={t.orange} animate={moving} />
								) : (
									<Text color={t.orange}>{FIGURE_EIGHT_STILL}</Text>
								)}
								<Text color={t.textPrimary} bold>
									{" "}
									{clip(step.text, textMax)}
								</Text>
							</Text>
						);
					}
					return (
						<Text key={step.id} wrap="truncate-end">
							<Text color={t.textTertiary}>{g.pending} </Text>
							<Text color={t.textSecondary}>{clip(step.text, textMax)}</Text>
						</Text>
					);
				})}
			</Box>
			{!running && steps.length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					{planSummary(steps, elapsedMs, inner).map((line) => (
						<Text key={line} color={t.muted} wrap="truncate-end">
							{line}
						</Text>
					))}
				</Box>
			) : null}
			{toggleHint ? (
				<Box marginTop={1}>
					<KeyCapRow caps={[{ cap: toggleHint, verb: "hide" }]} idPrefix="plan" />
				</Box>
			) : null}
		</Box>
	);
}

/** The column opened by hand (Ctrl+X) with no plan: says so, invents nothing. */
export function PlanEmpty({ width = 24 }: { width?: number }) {
	return (
		<Box width={width} flexShrink={0} paddingX={1} flexDirection="column">
			<Text color={t.heading} bold>
				PLAN
			</Text>
			<Box marginTop={1}>
				<Text color={t.textTertiary}>No plan this turn.</Text>
			</Box>
		</Box>
	);
}

// ─── Open / closed, remembered across sessions ────────────────────────────

/**
 * "auto": the column shows while there is a plan (or saved tasks) and hides
 * otherwise. "hidden": the user closed it. "shown": the user opened it with
 * nothing in it yet. Only "hidden" is remembered across sessions, so a
 * restart never opens an empty column.
 */
export type PlanPref = "auto" | "hidden" | "shown";

const PREF_APP = "tui";
const PREF_KEY = "planColumnHidden";

async function loadHidden(): Promise<boolean | null> {
	try {
		const mod = await import("../../../../packages/db/src/index.js");
		const value = mod.getWorkspaceDb().getAppState<boolean>(PREF_APP, PREF_KEY);
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}

async function saveHidden(hidden: boolean): Promise<void> {
	try {
		const mod = await import("../../../../packages/db/src/index.js");
		mod.getWorkspaceDb().setAppState(PREF_APP, PREF_KEY, hidden);
	} catch {
		/* best effort, like the DJ deck */
	}
}

/** Whether the PLAN column is open, given the preference and its content. */
export function planColumnOpen(pref: PlanPref, hasContent: boolean): boolean {
	return pref === "shown" || (pref === "auto" && hasContent);
}

/** The PLAN column preference and its toggle (bound to Ctrl+X). */
export function usePlanPref(hasContent: boolean): [PlanPref, () => void] {
	const [pref, setPref] = useState<PlanPref>("auto");
	useEffect(() => {
		let live = true;
		void loadHidden().then((hidden) => {
			if (live && hidden) setPref("hidden");
		});
		return () => {
			live = false;
		};
	}, []);
	const toggle = useCallback(() => {
		setPref((prev) => {
			const next: PlanPref = planColumnOpen(prev, hasContent) ? "hidden" : hasContent ? "auto" : "shown";
			void saveHidden(next === "hidden");
			return next;
		});
	}, [hasContent]);
	return [pref, toggle];
}
