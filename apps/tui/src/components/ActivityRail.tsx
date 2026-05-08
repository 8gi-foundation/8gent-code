/**
 * ActivityRail - fixed-width right column for the three-zone TUI shell.
 *
 * Surfaces the agent's live ops in five stacked sections:
 *   - AGENT ACTIVITY heading
 *   - Active Tasks with progress bars
 *   - Tools status (read/patch/test/verify with state glyphs)
 *   - Providers (local/fallback/offline + latency)
 *   - Memory (hits/misses/cache)
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
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";
import { MetricRow, TruncatedValue } from "./RailRow.js";

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
		<Box width="100%" overflow="hidden" justifyContent="space-between">
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

interface ActiveTask {
	id: string;
	label: string;
	/** 0-100 */
	progress: number;
}

interface ToolStatus {
	name: string;
	state: ToolState;
}

interface ProviderRow {
	name: string;
	state: ProviderState;
	/** Round-trip latency hint, e.g. "42ms" or "—". */
	latency: string;
}

interface MemoryStats {
	hits: number;
	misses: number;
	cache: string;
}

interface AgentRow {
	name: string;
	state: AgentState;
}

interface ActivityRailProps {
	tasks: ReadonlyArray<ActiveTask>;
	tools: ReadonlyArray<ToolStatus>;
	providers: ReadonlyArray<ProviderRow>;
	memory: MemoryStats;
	agents: ReadonlyArray<AgentRow>;
	/** Live turn signals — when set, the TOOLS section reflects the active
	 *  turn (chat-truth) instead of the stale tools array. */
	isProcessing?: boolean;
	activeTool?: string | null;
	toolsCompleted?: number;
}

// Short-name a long provider:model string for the rail. The full
// identifier is fine in chat metadata; the rail wants a compact label.
//   "lmstudio:google/gemma-4-26b-a4b" -> "lmstudio:gemma"
//   "ollama:qwen3.6:27b"              -> "ollama:qwen"
function shortProvider(name: string): string {
	const families = ["gemma", "qwen", "llama", "deepseek", "mistral", "phi", "claude"];
	for (const fam of families) {
		if (name.toLowerCase().includes(fam)) {
			const tier = name.split(":")[0];
			return `${tier}:${fam}`;
		}
	}
	return name;
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
	fallback: t.orange,
	offline:  t.red,
};

const AGENT_COLOR: Record<AgentState, string> = {
	idle:    t.muted,
	active:  t.green,
	blocked: t.orange,
};

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
			<Text color={t.orange} bold>AGENT ACTIVITY</Text>

			<Box marginTop={1}>
				<Text color={t.orange} bold>TASKS</Text>
			</Box>
			{tasks.length === 0 ? (
				<Text color={t.muted}>idle</Text>
			) : (
				tasks.map((task) => (
					<Box key={task.id} flexDirection="column">
						<Text color={t.textPrimary} wrap="truncate-end">{task.label}</Text>
						<Box width="100%" overflow="hidden" justifyContent="space-between">
							<Text color={t.steel}>{bar(task.progress)}</Text>
							<Text color={t.textSecondary}>{`${task.progress}%`}</Text>
						</Box>
					</Box>
				))
			)}

			<Box marginTop={1}>
				<Text color={t.orange} bold>TOOLS</Text>
			</Box>
			{(() => {
				// Prefer live turn state (chat-truth) over the stale tools array.
				// Falls back to the array when no isProcessing signal is wired.
				const liveActive = isProcessing ? (activeTool ?? "reasoning") : null;
				const arrayActive = tools.find((tl) => tl.state === "running")?.name ?? null;
				const active = liveActive ?? arrayActive;
				const done = toolsCompleted ?? tools.filter((tl) => tl.state === "ok").length;
				const queued = tools.filter((tl) => tl.state === "idle").length;
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
							color={queued > 0 ? t.orange : t.dim}
						/>
					</>
				);
			})()}

			<Box marginTop={1}>
				<Text color={t.orange} bold>PROVIDERS</Text>
			</Box>
			{providers.map((provider) => (
				<NamedRow
					key={provider.name}
					name={`● ${shortProvider(provider.name)}`}
					color={PROVIDER_COLOR[provider.state]}
					trailing={provider.latency}
				/>
			))}

			<Box marginTop={1}>
				<Text color={t.orange} bold>MEMORY</Text>
			</Box>
			<MetricRow label="hits" value={String(memory.hits)} color={t.green} />
			<MetricRow label="misses" value={String(memory.misses)} color={t.orange} />
			<MetricRow label="cache" value={memory.cache} color={t.textSecondary} />

			<Box marginTop={1}>
				<Text color={t.orange} bold>AGENTS</Text>
			</Box>
			{agents.map((agent) => (
				<NamedRow
					key={agent.name}
					name={`● ${agent.name}`}
					color={AGENT_COLOR[agent.state]}
				/>
			))}
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
};
