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
import { RailRow } from "./RailRow.js";

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
						<Text color={t.textSecondary} wrap="truncate-end">{task.label}</Text>
						<RailRow
							label={bar(task.progress)}
							value={`${task.progress}%`}
							color={t.dim}
						/>
					</Box>
				))
			)}

			<Box marginTop={1}>
				<Text color={t.orange} bold>TOOLS</Text>
			</Box>
			{tools.map((tool) => (
				<RailRow
					key={tool.name}
					label={`${TOOL_GLYPH[tool.state]} ${tool.name}`}
					value=""
					color={TOOL_COLOR[tool.state]}
				/>
			))}

			<Box marginTop={1}>
				<Text color={t.orange} bold>PROVIDERS</Text>
			</Box>
			{providers.map((provider) => (
				<RailRow
					key={provider.name}
					label={`● ${provider.name}`}
					value={provider.latency}
					color={PROVIDER_COLOR[provider.state]}
				/>
			))}

			<Box marginTop={1}>
				<Text color={t.orange} bold>MEMORY</Text>
			</Box>
			<RailRow label="hits" value={String(memory.hits)} color={t.green} />
			<RailRow label="misses" value={String(memory.misses)} color={t.orange} />
			<RailRow label="cache" value={memory.cache} color={t.steel} />

			<Box marginTop={1}>
				<Text color={t.orange} bold>AGENTS</Text>
			</Box>
			{agents.map((agent) => (
				<RailRow
					key={agent.name}
					label={`● ${agent.name}`}
					value=""
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
