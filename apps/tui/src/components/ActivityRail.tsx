/**
 * ActivityRail - fixed-width right column for the three-zone TUI shell.
 *
 * Surfaces the agent's live ops in five stacked sections:
 *   - AGENT ACTIVITY heading
 *   - Active Tasks with progress bars
 *   - Tools status (read/patch/test/verify with state glyphs)
 *   - Providers (the configured route, its real failover hop, and a
 *     latency only when one was measured)
 *   - Memory (hits/misses/cache, each row only when a source reports it;
 *     the section is absent when none does)
 *   - Agents row (Core/Research/Tester/Reviewer with LED dots)
 *
 * Pure presentational: caller owns every value, no internal state, no
 * effects. Width pinned to 34 cols, single border. Theme tokens only.
 *
 * Section headings sit in a Box with marginTop instead of an empty Text
 * spacer so Ink does not collapse the blank line in some renderers (which
 * previously caused MEMORY/cache labels to collide with the preceding
 * section's last data row).
 *
 * Data rows use the shared RailRow helper so labels and values can never
 * fuse at narrow widths (the bug that produced `MEMORYrouter`).
 *
 * Every row and section is flexShrink=0 so a short terminal clips the
 * rail at the bottom instead of stacking rows on top of each other (the
 * bug that produced `idleS` at 100x30, #2921).
 */

import { Box, Text } from "ink";
import React from "react";
import { queuedToolCount } from "../lib/activity-rail-derivation.js";
import { t } from "../theme.js";
import { MetricRow, TruncatedValue } from "./RailRow.js";

// RailSection wraps a heading and its rows in a discrete column block.
// Without this, Ink can fuse the heading line with the next row at narrow
// widths (the `hitsRY` bug, MEMORY heading running into a cache row tail).
// Explicit column + marginTop + width=100% guarantees row separation.
//
// Every block is flexShrink=0. Ink boxes shrink by default, so when the
// rail is taller than the shell (a 30-row terminal) yoga squeezed each
// section to a fraction of a row and headings overprinted their values
// (`idleS` at 100x30). With shrink off the rail keeps its natural height
// and the outer overflow="hidden" clips whatever does not fit.
//
// Rows must NOT set overflow="hidden" of their own: Ink applies only the
// innermost clip, so a row-level clip replaces the rail's clip and lets
// the row paint straight through the rail border and the bars below it.
function RailSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Box flexDirection="column" marginTop={1} width="100%" flexShrink={0}>
			<Box flexShrink={0}>
				<Text color={t.heading} bold>{title}</Text>
			</Box>
			<Box flexDirection="column" width="100%" flexShrink={0}>
				{children}
			</Box>
		</Box>
	);
}

// NamedRow renders a primary name on the left (truncate-middle so head and
// tail are both visible — important for `lmstudio:google/gemma-4-26b-a4b`)
// and an optional trailing value on the right (latency, count, etc).
function NamedRow({
	name,
	color,
	trailing,
	trailingColor = t.dim,
}: {
	name: string;
	color: string;
	trailing?: string;
	trailingColor?: string;
}) {
	return (
		<Box width="100%" flexShrink={0} justifyContent="space-between">
			<Box flexGrow={1} minWidth={0}>
				<TruncatedValue value={name} color={color} />
			</Box>
			{trailing ? (
				<Box flexShrink={0} marginLeft={1}>
					<Text color={trailingColor}>{trailing}</Text>
				</Box>
			) : null}
		</Box>
	);
}

type ToolState = "idle" | "running" | "ok" | "fail";
type ProviderState = "local" | "fallback" | "offline";
type AgentState = "idle" | "active" | "blocked";
type BodyPartState = "disabled" | "idle" | "inFlight";

interface BodyPartsRow {
	hands: BodyPartState;
	eyes: BodyPartState;
	handeyes: BodyPartState;
}

interface ActiveTask {
	id: string;
	label: string;
	/** 0-100, the real share of plan steps done. No bar when absent. */
	progress?: number;
	/** Right-hand tally beside the bar, e.g. "2/5". Defaults to `${progress}%`. */
	detail?: string;
}

interface ToolStatus {
	name: string;
	state: ToolState;
}

interface ProviderRow {
	name: string;
	state: ProviderState;
	/** Measured round-trip latency, e.g. "42ms". Absent when unmeasured. */
	latency?: string;
}

/**
 * Memory counters. Each field is present only when a real source reports
 * it: a row is never drawn for a count nobody measured. The memory store
 * (packages/memory/store.ts) exposes no hit/miss or cache counter yet, so
 * the TUI passes nothing and the MEMORY section does not render.
 */
interface MemoryStats {
	hits?: number;
	misses?: number;
	cache?: string;
}

interface AgentRow {
	name: string;
	state: AgentState;
}

interface ActivityRailProps {
	tasks: ReadonlyArray<ActiveTask>;
	tools: ReadonlyArray<ToolStatus>;
	providers: ReadonlyArray<ProviderRow>;
	memory?: MemoryStats;
	agents: ReadonlyArray<AgentRow>;
	/** Live turn signals - when set, the TOOLS section reflects the active
	 *  turn (chat-truth) instead of the stale tools array. */
	isProcessing?: boolean;
	activeTool?: string | null;
	toolsCompleted?: number;
	/** Body-parts indicators: hands, eyes, handeyes. Optional - rail still
	 *  renders without the BODY section when undefined, preserving callers
	 *  that have not yet wired the useBodyParts hook. */
	bodyParts?: BodyPartsRow;
}

// Friendly route label. The rail surfaces the agent's tiering, not the
// vendor SKU. Translates raw provider:model identifiers to operator
// vocabulary: local / fallback / remote.
function providerDisplay(value: string): string {
	const v = value.toLowerCase();
	if (v.includes("lmstudio")) {
		if (v.includes("gemma")) return "local:gemma";
		if (v.includes("qwen")) return "local:qwen";
		if (v.includes("llama")) return "local:llama";
		return "local:lm";
	}
	if (v.includes("ollama")) {
		if (v.includes("qwen")) return "local:qwen";
		if (v.includes("llama")) return "local:llama";
		if (v.includes("gemma")) return "local:gemma";
		return "local:ollama";
	}
	if (v.includes("openrouter")) return "fallback:free";
	if (v.includes("apfel") || v.includes("apple")) return "local:apfel";
	if (v.includes("deepseek")) return "remote:deepseek";
	if (v.includes("anthropic") || v.includes("claude")) return "remote:standby";
	if (v.includes("openai") || v.includes("gpt")) return "remote:standby";
	return "route:available";
}

const TOOL_GLYPH: Record<ToolState, string> = {
	idle:    "○",
	running: "◐",
	ok:      "●",
	fail:    "✕",
};

const TOOL_COLOR: Record<ToolState, string> = {
	idle:    t.muted,
	running: t.teal,
	ok:      t.green,
	fail:    t.red,
};

const PROVIDER_COLOR: Record<ProviderState, string> = {
	local:    t.green,
	fallback: t.textSecondary,
	offline:  t.red,
};

// The route in use is filled; a standby route is a hollow ring, and says
// what it is in words, so the two rows never differ by colour alone
// (both can read `local:...`). A measured latency takes the word's place.
const PROVIDER_GLYPH: Record<ProviderState, string> = {
	local:    "●",
	fallback: "○",
	offline:  "✕",
};

const PROVIDER_ROLE: Record<ProviderState, string | undefined> = {
	local:    undefined,
	fallback: "fallback",
	offline:  "offline",
};

const AGENT_COLOR: Record<AgentState, string> = {
	idle:    t.muted,
	active:  t.green,
	blocked: t.textPrimary,
};

// Body-parts taxonomy: hands (cliclick), eyes (AX bridge), handeyes
// (engagement loop). Three observable states map to three glyphs in the
// same visual family as the TOOLS section so a quick glance reads as a
// uniform inspector, not a stylistic outlier.
//
//   disabled - outlined hollow ring, dim text
//   idle     - filled bright ring, bright text (enabled, ready)
//   inFlight - inverted/pulsed bullseye, teal accent (live tool call)
const BODY_GLYPH: Record<BodyPartState, string> = {
	disabled: "○",
	idle:     "●",
	inFlight: "◉",
};

const BODY_COLOR: Record<BodyPartState, string> = {
	disabled: t.muted,
	idle:     t.green,
	inFlight: t.teal,
};

const BODY_PART_LABELS: ReadonlyArray<{ key: keyof BodyPartsRow; label: string }> = [
	{ key: "hands",    label: "hands" },
	{ key: "eyes",     label: "eyes" },
	{ key: "handeyes", label: "handeyes" },
];

function hasMemoryRows(memory: MemoryStats | undefined): memory is MemoryStats {
	if (!memory) return false;
	return typeof memory.hits === "number" || typeof memory.misses === "number" || Boolean(memory.cache);
}

function bar(percent: number, width = 12): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function ActivityRail({
	tasks,
	tools,
	providers,
	memory,
	agents,
	isProcessing = false,
	activeTool = null,
	toolsCompleted,
	bodyParts,
}: ActivityRailProps) {
	return (
		<Box
			width={34}
			flexShrink={0}
			borderStyle="single"
			borderColor={t.border}
			paddingX={1}
			flexDirection="column"
			overflow="hidden"
		>
			<Box flexShrink={0}>
				<Text color={t.heading} bold>AGENT ACTIVITY</Text>
			</Box>

			<RailSection title="TASKS">
				{tasks.length === 0 ? (
					<Box flexShrink={0}>
						<Text color={t.muted}>idle</Text>
					</Box>
				) : (
					tasks.map((task) => (
						<Box key={task.id} flexDirection="column" flexShrink={0}>
							<Text
								color={typeof task.progress === "number" ? t.textPrimary : t.teal}
								wrap="truncate-end"
							>
								{task.label}
							</Text>
							{typeof task.progress === "number" ? (
								<Box width="100%" flexShrink={0} justifyContent="space-between">
									<Text color={t.steel}>{bar(task.progress)}</Text>
									<Text color={t.textSecondary}>{task.detail ?? `${task.progress}%`}</Text>
								</Box>
							) : null}
						</Box>
					))
				)}
			</RailSection>

			<RailSection title="TOOLS">
				{(() => {
					// Live turn state (chat-truth) wins over the tools array: while
					// a turn runs with no tool in flight the agent is reasoning,
					// and once it ends nothing is active or queued.
					const arrayActive = isProcessing
						? (tools.find((tl) => tl.state === "running")?.name ?? null)
						: null;
					const active = isProcessing ? (activeTool ?? arrayActive ?? "reasoning") : null;
					const done = toolsCompleted ?? tools.filter((tl) => tl.state === "ok").length;
					const queued = queuedToolCount(tools, isProcessing);
					return (
						<>
							<MetricRow
								label="active"
								value={active ?? "none"}
								color={active ? t.teal : t.dim}
							/>
							<MetricRow label="done" value={String(done)} color={t.textSecondary} />
							<MetricRow
								label="queued"
								value={String(queued)}
								color={queued > 0 ? t.textPrimary : t.dim}
							/>
						</>
					);
				})()}
			</RailSection>

			<RailSection title="PROVIDERS">
				{providers.map((provider) => (
					<NamedRow
						key={provider.name}
						name={`${PROVIDER_GLYPH[provider.state]} ${providerDisplay(provider.name)}`}
						color={PROVIDER_COLOR[provider.state]}
						trailing={provider.latency ?? PROVIDER_ROLE[provider.state]}
					/>
				))}
			</RailSection>

			{hasMemoryRows(memory) ? (
				<RailSection title="MEMORY">
					{typeof memory.hits === "number" ? (
						<MetricRow label="hits" value={String(memory.hits)} color={t.green} />
					) : null}
					{typeof memory.misses === "number" ? (
						<MetricRow label="misses" value={String(memory.misses)} color={t.textSecondary} />
					) : null}
					{memory.cache ? (
						<MetricRow label="cache" value={memory.cache} color={t.textSecondary} />
					) : null}
				</RailSection>
			) : null}

			<RailSection title="AGENTS">
				{agents.map((agent) => (
					<NamedRow
						key={agent.name}
						name={`● ${agent.name}`}
						color={AGENT_COLOR[agent.state]}
					/>
				))}
			</RailSection>

			{bodyParts ? (
				<RailSection title="BODY">
					{BODY_PART_LABELS.map(({ key, label }) => {
						const state = bodyParts[key];
						return (
							<NamedRow
								key={key}
								name={`${BODY_GLYPH[state]} ${label}`}
								color={BODY_COLOR[state]}
							/>
						);
					})}
				</RailSection>
			) : null}
		</Box>
	);
}

export type {
	ActivityRailProps,
	ActiveTask,
	ToolStatus,
	ToolState,
	ProviderRow,
	ProviderState,
	MemoryStats,
	AgentRow,
	AgentState,
	BodyPartState,
	BodyPartsRow,
};
