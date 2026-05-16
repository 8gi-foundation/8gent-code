/**
 * LiveFocalStrip - single horizontal strip above the message list that
 * always answers "what is happening NOW?"
 *
 * One canonical pulse: mode + active step on the left, route + context
 * meter + token count on the right. Border is teal by default and flips
 * to orange when an approval is pending so the eye lands on it without
 * a second glance.
 *
 * Pure presentational: no state, no effects, no side-channels. Caller
 * owns every value.
 *
 * Per TUI North Star v2 PRD snippet 1 (issue #2335).
 *
 * Goal-loop integration (issue #2608): the pure LiveFocalStrip stays
 * untouched. A second component, LiveFocalStripWithGoal, wraps it and
 * subscribes to /go events from a GoalClient. It owns:
 *   - the one-line default display ("Going. Sub-goal x of y...")
 *   - Ctrl+G chord to expand to the 3-line BRAND.md form
 *   - ADHD-mode override to stay on the one-liner
 *   - terminal-state KittenTTS fire-once via ~/.claude/bin/kittentts-say
 *
 * Splitting the wrapper from the pure strip keeps the existing unit
 * tests deterministic and makes the goal pathway opt-in per surface.
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import {
	VERDICT_DONE,
	VERDICT_STILL_GOING,
	VERDICT_STOPPED,
	VERDICT_STUCK,
	assembleVerdict,
} from "../../../../packages/eight/go/index.js";
import type { GoalClient } from "../lib/goal-client.js";
import { t } from "../theme.js";

type Mode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";

interface LiveFocalStripProps {
	mode: Mode;
	activeStep: string;
	route: string;
	tokens: string;
	contextPct: number;
	approvalPending?: boolean;
	/** When the agent is running unattended (auto-approve all), the focal
	 *  strip swaps the mode label for "Autonomous" so the operator instantly
	 *  knows manual approvals are off. Border also stays teal regardless of
	 *  approvalPending because nothing is actually waiting on the user. */
	autonomous?: boolean;
	/** True when the agent is actively processing. Drives the NOW vs READY
	 *  state label - we don't shout "NOW" at an idle TUI. */
	isProcessing?: boolean;
}

/**
 * Render a fixed-width unicode meter from a percent value. Inputs over
 * 100 or below 0 are clamped so the strip never overflows or underflows.
 */
export function meter(percent: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function LiveFocalStrip({
	mode,
	activeStep,
	route,
	tokens,
	contextPct,
	approvalPending = false,
	autonomous = false,
	isProcessing = false,
}: LiveFocalStripProps) {
	const displayMode = autonomous ? "Autonomous" : mode;
	const showApprovalBorder = approvalPending && !autonomous;
	const stateLabel = isProcessing ? "NOW" : "READY";
	return (
		<Box
			width="100%"
			minHeight={isProcessing ? 3 : 1}
			borderStyle={isProcessing ? "round" : "single"}
			borderColor={showApprovalBorder ? t.orange : isProcessing ? t.teal : t.border}
			paddingX={1}
			justifyContent="space-between"
			flexShrink={0}
			overflow="hidden"
		>
			<Box width={22} flexShrink={0}>
				<Text color={isProcessing ? t.teal : t.muted}>◆ {stateLabel} </Text>
				<Text color={t.textPrimary} bold wrap="truncate-end">
					{displayMode}
				</Text>
			</Box>

			<Box flexGrow={1} minWidth={0} paddingX={1}>
				<Text color={t.textSecondary} wrap="truncate-end">
					{isProcessing ? activeStep : "idle"}
				</Text>
			</Box>

			<Box width={42} flexShrink={0} justifyContent="flex-end">
				<Text color={t.steel} wrap="truncate-middle">{route}</Text>
				<Text color={t.dim}> ctx </Text>
				<Text color={t.steel}>{meter(contextPct)}</Text>
				<Text color={t.dim}> {tokens}</Text>
			</Box>
		</Box>
	);
}

export type { LiveFocalStripProps };

// ============================================
// Goal-loop overlay (issue #2608)
// ============================================

/**
 * In-memory snapshot of the goal-loop state the strip needs to render.
 * Held outside React state until a goal event arrives so the strip
 * stays at zero overhead in the dominant idle path.
 */
export interface GoalStripState {
	runId: string | null;
	/** Last terminal verdict, if the run finished. Null while running. */
	terminal: "done" | "stopped" | "stuck" | null;
	/** Current sub-goal counter (1-based). */
	subgoal: { index: number; total: number; text: string } | null;
	/** Elapsed millis since run started. */
	elapsedMs: number;
	/** Total turns observed so far. */
	turns: number;
	/** Verdict copy ready for display. */
	verdictLine: string;
}

/**
 * Format an elapsed-time duration as "12s" / "1m24s" / "1h02m".
 * Compact because the focal strip has very little room.
 */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remSecs = secs % 60;
	if (mins < 60) return `${mins}m${remSecs.toString().padStart(2, "0")}s`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hours}h${remMins.toString().padStart(2, "0")}m`;
}

/**
 * Build the single-line goal display per the BRAND.md one-liner spec:
 *   "Going. Sub-goal x of y: {current}. {elapsed} ●"
 * Falls back to a /go-aware "Ready." when no run is in flight.
 */
export function buildGoalLine(state: GoalStripState): string {
	if (state.terminal) return state.verdictLine;
	if (state.subgoal) {
		return `Going. Sub-goal ${state.subgoal.index} of ${state.subgoal.total}: ${state.subgoal.text}. ${formatElapsed(state.elapsedMs)}`;
	}
	if (state.runId) {
		return `Going. ${formatElapsed(state.elapsedMs)}`;
	}
	return "Ready.";
}

interface LiveFocalStripWithGoalProps extends LiveFocalStripProps {
	/** Optional goal client to subscribe to. */
	goalClient?: GoalClient | null;
	/** ADHD-mode override: stay on the one-liner regardless of expansion. */
	adhdMode?: boolean;
	/** Path override for KittenTTS binary. Useful in tests. */
	kittenTtsPath?: string;
	/** Test seam: skip child_process spawn (KittenTTS) even on terminal events. */
	disableTts?: boolean;
	/** Test seam: inject initial goal state without driving event listeners. */
	initialGoalState?: Partial<GoalStripState>;
}

/**
 * Goal-aware wrapper around the pure LiveFocalStrip. Subscribes to a
 * GoalClient and reflects the loop state in a one-line overlay above
 * the regular strip. Ctrl+G toggles the 3-line expansion; ADHD mode
 * keeps it collapsed regardless.
 */
export function LiveFocalStripWithGoal(props: LiveFocalStripWithGoalProps) {
	const {
		goalClient = null,
		adhdMode = false,
		kittenTtsPath,
		disableTts = false,
		initialGoalState,
		...stripProps
	} = props;

	const [expanded, setExpanded] = useState(false);
	const [goalState, setGoalState] = useState<GoalStripState>(() => ({
		runId: initialGoalState?.runId ?? null,
		terminal: initialGoalState?.terminal ?? null,
		subgoal: initialGoalState?.subgoal ?? null,
		elapsedMs: initialGoalState?.elapsedMs ?? 0,
		turns: initialGoalState?.turns ?? 0,
		verdictLine: initialGoalState?.verdictLine ?? "",
	}));
	const startedAtRef = useRef<number | null>(null);
	const spokenForRunRef = useRef<string | null>(null);

	// Ctrl+G chord toggles the expanded form. Honour ADHD mode by
	// short-circuiting back to collapsed.
	useInput(
		(_input, key) => {
			if (key.ctrl && _input === "g") {
				setExpanded((prev) => (adhdMode ? false : !prev));
			}
		},
		{ isActive: true },
	);

	useEffect(() => {
		if (adhdMode && expanded) setExpanded(false);
	}, [adhdMode, expanded]);

	// Subscribe to the goal client. Cleanup tears down listeners.
	useEffect(() => {
		if (!goalClient) return;
		const unsub = goalClient.subscribe({
			onStarted: (runId) => {
				startedAtRef.current = Date.now();
				spokenForRunRef.current = null;
				setGoalState({
					runId,
					terminal: null,
					subgoal: null,
					elapsedMs: 0,
					turns: 0,
					verdictLine: "",
				});
			},
			onTurn: (event) => {
				setGoalState((prev) => ({
					...prev,
					turns: prev.turns + (event.kind === "turn.completed" ? 1 : 0),
					elapsedMs: startedAtRef.current
						? Date.now() - startedAtRef.current
						: prev.elapsedMs,
				}));
			},
			onSubgoalEvent: (event) => {
				const payload = (event.payload ?? {}) as {
					index?: number;
					total?: number;
					text?: string;
				};
				const index = payload.index ?? 1;
				const total = payload.total ?? Math.max(index, 1);
				const text = payload.text ?? "...";
				setGoalState((prev) => ({
					...prev,
					subgoal: { index, total, text },
					verdictLine: assembleVerdict("still_going", {
						kind: "still_going",
						x: index,
						y: total,
					}),
				}));
				// Screen-reader-only announce. Ink doesn't emit ARIA, so this
				// is logged on stderr where assistive readers running over a
				// terminal multiplexer can be hooked. Voiced output is
				// reserved for terminal state per accessibility rule.
				if (!disableTts) {
					process.stderr.write(
						`[1;90m[sr] sub-goal ${index} of ${total}: ${text}[0m\n`,
					);
				}
			},
			onDone: (event) => {
				const kind = event.kind;
				let terminal: GoalStripState["terminal"];
				let verdictLine: string;
				switch (kind) {
					case "run.completed":
						terminal = "done";
						verdictLine = assembleVerdict("done", {
							kind: "done",
							n: (event.payload as { turn?: number })?.turn ?? 1,
						});
						break;
					case "run.aborted": {
						terminal = "stopped";
						verdictLine = assembleVerdict("stopped", {
							kind: "stopped",
							reason: (event.payload as { reason?: string })?.reason ?? "aborted",
						});
						break;
					}
					case "run.failed": {
						terminal = "stuck";
						verdictLine = VERDICT_STUCK;
						break;
					}
					default:
						return;
				}
				setGoalState((prev) => ({ ...prev, terminal, verdictLine }));

				// Terminal-state KittenTTS: fire exactly once per run. NEVER
				// ElevenLabs (per project hard rule). KittenTTS is local,
				// free, deterministic.
				if (disableTts) return;
				const runId = goalState.runId ?? "current";
				if (spokenForRunRef.current === runId) return;
				spokenForRunRef.current = runId;
				speakWithKittenTts(verdictLine, kittenTtsPath);
			},
		});
		return unsub;
	// goalClient identity changes are the only meaningful resubscribe
	// trigger; the listener closures intentionally read mutable refs.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goalClient, adhdMode, disableTts, kittenTtsPath]);

	const goalLine = useMemo(() => buildGoalLine(goalState), [goalState]);
	const showExpanded = expanded && !adhdMode && goalState.runId !== null;
	const goalBorderColor = goalState.terminal === "stuck" ? t.orange : t.teal;

	if (!goalState.runId && !goalState.verdictLine) {
		// No /go traffic yet. Render only the canonical strip.
		return <LiveFocalStrip {...stripProps} />;
	}

	return (
		<Box flexDirection="column" flexShrink={0}>
			<Box
				borderStyle="single"
				borderColor={goalBorderColor}
				paddingX={1}
				flexDirection="column"
			>
				<Text color={t.textPrimary} wrap="truncate-end">
					{goalLine}{" "}
					<Text color={t.orange}>●</Text>
				</Text>
				{showExpanded && (
					<>
						<Text color={t.muted} wrap="truncate-end">
							turns: {goalState.turns} · elapsed: {formatElapsed(goalState.elapsedMs)}
						</Text>
						<Text color={t.muted} wrap="truncate-end">
							Ctrl+G to collapse · /go ? for help
						</Text>
					</>
				)}
			</Box>
			<LiveFocalStrip {...stripProps} />
		</Box>
	);
}

/**
 * Fire-and-forget KittenTTS playback. Spawned detached so we never
 * block the TUI render. Failures are swallowed - terminal-state
 * verdicts are visual-primary, voice is the accessibility companion.
 *
 * Hard rule (feedback_kittentts_only 2026-04-20): KittenTTS only,
 * never ElevenLabs. Path is overridable for tests but defaults to the
 * canonical user-bin location.
 */
export function speakWithKittenTts(line: string, path?: string): void {
	try {
		const bin = path ?? pathJoin(homedir(), ".claude", "bin", "kittentts-say");
		const child = spawn(bin, [line], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// Best-effort. Voice is the accessibility companion, not the path.
	}
}

export type { LiveFocalStripWithGoalProps };
