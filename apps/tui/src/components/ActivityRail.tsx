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
 * effects. Width pinned to 32 cols, single border. Theme tokens only.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

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
}: ActivityRailProps) {
	return (
		<Box
			width={32}
			flexShrink={0}
			borderStyle="single"
			borderColor={t.border}
			paddingX={1}
			flexDirection="column"
			overflow="hidden"
		>
			<Text color={t.orange} bold>AGENT ACTIVITY</Text>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>TASKS</Text>
			{tasks.length === 0 ? (
				<Text color={t.muted}>idle</Text>
			) : (
				tasks.map((task) => (
					<Box key={task.id} flexDirection="column">
						<Text color={t.textSecondary} wrap="truncate-end">{task.label}</Text>
						<Box>
							<Text color={t.steel}>{bar(task.progress)}</Text>
							<Text color={t.dim}> {task.progress}%</Text>
						</Box>
					</Box>
				))
			)}

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>TOOLS</Text>
			{tools.map((tool) => (
				<Box key={tool.name}>
					<Text color={TOOL_COLOR[tool.state]}>{TOOL_GLYPH[tool.state]} </Text>
					<Text color={t.textSecondary}>{tool.name}</Text>
				</Box>
			))}

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>PROVIDERS</Text>
			{providers.map((provider) => (
				<Box key={provider.name} justifyContent="space-between">
					<Box>
						<Text color={PROVIDER_COLOR[provider.state]}>● </Text>
						<Text color={t.textSecondary} wrap="truncate-end">{provider.name}</Text>
					</Box>
					<Text color={t.dim}>{provider.latency}</Text>
				</Box>
			))}

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>MEMORY</Text>
			<Box justifyContent="space-between">
				<Text color={t.muted}>hits</Text>
				<Text color={t.green}>{memory.hits}</Text>
			</Box>
			<Box justifyContent="space-between">
				<Text color={t.muted}>misses</Text>
				<Text color={t.orange}>{memory.misses}</Text>
			</Box>
			<Box justifyContent="space-between">
				<Text color={t.muted}>cache</Text>
				<Text color={t.steel}>{memory.cache}</Text>
			</Box>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>AGENTS</Text>
			{agents.map((agent) => (
				<Box key={agent.name}>
					<Text color={AGENT_COLOR[agent.state]}>● </Text>
					<Text color={t.textSecondary}>{agent.name}</Text>
				</Box>
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
