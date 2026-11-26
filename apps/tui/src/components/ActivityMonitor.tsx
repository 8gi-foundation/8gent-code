/**
 * ActivityMonitor - Real-time visualization of agent work
 *
 * Replaces the decorative ThinkingView with a live feed showing
 * what the agent is actually doing: URLs being fetched, files being
 * read, code being written, commands being run.
 *
 * Shows a contained "mini screen" with scrolling activity log,
 * making the agent's work visible and comprehensible.
 */

import { Box, Text, useStdout } from "ink";
import React, { useState, useSyncExternalStore } from "react";
import type { TaskInfo, TaskOutput, TaskStatus } from "../../../../packages/tools/background.js";
import { t } from "../theme.js";
import { ThinkingVisualizer } from "./ThinkingVisualizer.js";

// ── Activity Types ──────────────────────────────────────────────────

interface ActivityEntry {
	id: string;
	tool: string;
	action: string;
	detail: string;
	icon: string;
	color: "cyan" | "green" | "yellow" | "magenta" | "blue" | "red";
	timestamp: number;
	done: boolean;
	durationMs?: number;
}

// ── Tool → Visual Mapping ───────────────────────────────────────────

function toolToActivity(
	toolName: string,
	args: Record<string, unknown>,
): {
	action: string;
	detail: string;
	icon: string;
	color: "cyan" | "green" | "yellow" | "magenta" | "blue" | "red";
} {
	switch (toolName) {
		case "web_search":
			return {
				action: "SEARCH",
				detail: String(args.query || "").slice(0, 60),
				icon: "🔍",
				color: "cyan",
			};
		case "web_fetch":
			return {
				action: "FETCH",
				detail: String(args.url || "")
					.replace(/^https?:\/\//, "")
					.slice(0, 50),
				icon: "🌐",
				color: "cyan",
			};
		case "read_file": {
			const path = String(args.path || "");
			const short = path.split("/").slice(-2).join("/");
			return {
				action: "READ",
				detail: short.slice(0, 50),
				icon: "📄",
				color: "blue",
			};
		}
		case "write_file": {
			const path = String(args.path || "");
			const short = path.split("/").slice(-2).join("/");
			return {
				action: "WRITE",
				detail: short.slice(0, 50),
				icon: "✏️",
				color: "green",
			};
		}
		case "edit_file": {
			const path = String(args.path || "");
			const short = path.split("/").slice(-2).join("/");
			return {
				action: "EDIT",
				detail: short.slice(0, 50),
				icon: "🔧",
				color: "yellow",
			};
		}
		case "run_command": {
			const cmd = String(args.command || "");
			return {
				action: "RUN",
				detail: cmd,
				icon: "▶",
				color: "magenta",
			};
		}
		case "search_text":
		case "search_symbols":
			return {
				action: "GREP",
				detail: String(args.query || args.pattern || "").slice(0, 50),
				icon: "🔎",
				color: "yellow",
			};
		case "list_files":
			return {
				action: "LIST",
				detail: String(args.path || ".")
					.split("/")
					.slice(-2)
					.join("/"),
				icon: "📁",
				color: "blue",
			};
		case "git_commit":
			return {
				action: "GIT",
				detail: String(args.message || "commit").slice(0, 50),
				icon: "⎇",
				color: "green",
			};
		default:
			return {
				action: toolName.toUpperCase().slice(0, 8),
				detail: JSON.stringify(args).slice(0, 40),
				icon: "⚙",
				color: "cyan",
			};
	}
}

// ── Props ───────────────────────────────────────────────────────────

interface ActivityMonitorProps {
	/** Currently active tool name */
	activeTool: string | null;
	/** Step count */
	stepCount: number;
	/** Tool count */
	toolCount: number;
	/** Processing stage */
	processingStage: "planning" | "toolshed" | "executing" | "complete";
	/** Live "waiting for model, N s" line while nothing has happened yet (#133) */
	waitLine?: string | null;
	/** Max visible entries */
	maxEntries?: number;
	/** When false, draw plain markers and no thinking visualiser (matches global ^A anim toggle) */
	showAnimations?: boolean;
	/** Compact mode: strict fixed-height box for embedding in the chat view */
	compact?: boolean;
	/** Available width for the compact box (avoids reading stdout.columns) */
	contentWidth?: number;
}

// ── Singleton activity log (persists across re-renders) ─────────────

const activityLog: ActivityEntry[] = [];
let logVersion = 0;

// The monitor redraws when the log changes, never on a timer (#4976):
// lib/motion.ts says nothing loops.
const logListeners = new Set<() => void>();

function logChanged(): void {
	logVersion++;
	for (const listener of logListeners) listener();
}

function subscribeToLog(listener: () => void): () => void {
	logListeners.add(listener);
	return () => {
		logListeners.delete(listener);
	};
}

function getLogVersion(): number {
	return logVersion;
}

export function pushActivity(
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): void {
	const { action, detail, icon, color } = toolToActivity(toolName, args);
	activityLog.push({
		id: toolCallId,
		tool: toolName,
		action,
		detail,
		icon,
		color,
		timestamp: Date.now(),
		done: false,
	});
	// Keep max 50 entries
	if (activityLog.length > 50) activityLog.shift();
	logChanged();
}

export function completeActivity(toolCallId: string, success: boolean, durationMs: number): void {
	const entry = activityLog.find((e) => e.id === toolCallId);
	if (entry) {
		entry.done = true;
		entry.durationMs = durationMs;
		if (!success) entry.color = "red";
	}
	logChanged();
}

export function clearActivity(): void {
	activityLog.length = 0;
	logChanged();
}

const AGENT_TASK_PREFIX = "agent-op-";

/** Map recent tool traces into TaskInfo rows for the Processes sidebar (merged with shell jobs). */
export function getActivityLogAsTaskInfos(): TaskInfo[] {
	return activityLog.map((entry) => {
		const now = Date.now();
		const done = entry.done;
		const failed = done && entry.color === "red";
		const status: TaskStatus = done ? (failed ? "failed" : "completed") : "running";
		const durationMs = done ? (entry.durationMs ?? 0) : Math.max(0, now - entry.timestamp);
		const startedAt = new Date(entry.timestamp).toISOString();
		const endedAt = done ? new Date(entry.timestamp + (entry.durationMs ?? 0)).toISOString() : null;
		return {
			id: `${AGENT_TASK_PREFIX}${entry.id}`,
			command: `◇ ${entry.tool} · ${entry.action}: ${entry.detail}`.slice(0, 140),
			status,
			exitCode: done ? (failed ? 1 : 0) : null,
			startedAt,
			endedAt,
			runtime: durationMs,
			outputLength: 0,
			errorLength: failed ? 1 : 0,
		};
	});
}

export function isAgentProcessTaskId(id: string): boolean {
	return id.startsWith(AGENT_TASK_PREFIX);
}

export function getAgentTaskOutput(taskId: string): TaskOutput | null {
	if (!taskId.startsWith(AGENT_TASK_PREFIX)) return null;
	const inner = taskId.slice(AGENT_TASK_PREFIX.length);
	const entry = activityLog.find((e) => e.id === inner);
	if (!entry) return null;
	const lines = [
		`Tool: ${entry.tool}`,
		`Action: ${entry.action}`,
		`Detail: ${entry.detail}`,
		`Status: ${entry.done ? (entry.color === "red" ? "failed" : "completed") : "running"}`,
		entry.durationMs != null ? `Duration: ${entry.durationMs}ms` : "",
	].filter(Boolean);
	const combined = lines.join("\n");
	return {
		id: taskId,
		stdout: combined,
		stderr: "",
		combined,
	};
}

// ── Component ───────────────────────────────────────────────────────

export function ActivityMonitor({
	activeTool,
	waitLine,
	stepCount,
	toolCount,
	processingStage,
	maxEntries = 12,
	showAnimations = true,
	compact = false,
	contentWidth,
}: ActivityMonitorProps) {
	const { stdout } = useStdout();
	const [startTime] = useState(() => Date.now());
	// Re-render when the activity log changes; the log itself is read below.
	useSyncExternalStore(subscribeToLog, getLogVersion, getLogVersion);

	const cols = stdout?.columns ?? 80;
	// In compact mode, use the caller-supplied width so we never exceed the container.
	// In full mode, use the Hermes-derived terminal width minus chrome.
	const visualiserWidth = compact
		? Math.max(16, (contentWidth ?? 40) - 4)
		: Math.max(24, Math.min(cols - 10, 96));

	const visibleEntries = activityLog.slice(-maxEntries);
	// Still glyphs: the work shows through new rows landing, not through a
	// cycling ellipsis or scan bar.
	const dots = "…";

	// Elapsed as of the last change (a tool landing or finishing), not a ticking clock.
	const secs = Math.floor((Date.now() - startTime) / 1000);
	const elapsedStr = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

	// The running entry's marker
	const scanBar = showAnimations ? "▸" : "·";

	const stageLabel =
		processingStage === "planning"
			? "THINKING"
			: processingStage === "executing"
				? "WORKING"
				: processingStage.toUpperCase();

	// Compact mode: strict fixed-height box aligned to the full content width, no overflow
	if (compact) {
		return (
			<Box
				flexDirection="row"
				height={4}
				overflow="hidden"
				borderStyle="single"
				borderColor={t.orange}
				paddingX={1}
				alignItems="center"
			>
				<Text color={t.orange} bold>
					{"8 "}
				</Text>
				<Box flexGrow={1} flexDirection="column" overflow="hidden">
					{visibleEntries.length === 0 ? (
						<Box>
							<Text color={t.orange} bold>
								{stageLabel}
							</Text>
							{waitLine ? (
								<Text color={t.textDim} wrap="truncate-end">{` ${waitLine}`}</Text>
							) : (
								showAnimations && <Text color={t.textDim}>{dots}</Text>
							)}
						</Box>
					) : (
						visibleEntries.slice(-2).map((entry) => (
							<Box key={entry.id}>
								<Text color={entry.done ? t.green : t.orange}>{entry.done ? "✓ " : "◦ "}</Text>
								<Box flexShrink={0}>
									<Text color={entry.color} wrap="truncate-end">
										{entry.action}
									</Text>
								</Box>
								<Box flexShrink={1} flexGrow={1}>
									<Text color={t.textTertiary} wrap="truncate-end">{` ${entry.detail}`}</Text>
								</Box>
							</Box>
						))
					)}
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color={t.textTertiary} wrap="truncate-end">
						{stepCount > 0
							? (contentWidth ?? 80) < 60
								? `#${stepCount}`
								: `step ${stepCount}`
							: ""}
					</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1}>
			{/* Header */}
			<Box marginBottom={1} flexDirection="row" alignItems="center">
				<Box flexShrink={1} flexDirection="row" overflow="hidden">
					<Text color="cyan" bold wrap="truncate-end">
						{`┌─ 8gent Activity `}
					</Text>
					<Text dimColor wrap="truncate-end">
						{`step ${stepCount} · ${toolCount} tools · ${elapsedStr}`}
					</Text>
				</Box>
				<Box flexGrow={1} flexShrink={0} />
				<Box flexShrink={0}>
					<Text color={processingStage === "executing" ? "green" : "yellow"} wrap="truncate">
						{stageLabel}
					</Text>
				</Box>
			</Box>

			{/* Activity feed — the "mini screen" */}
			<Box
				flexDirection="column"
				borderStyle="single"
				borderColor="cyan"
				paddingX={1}
				flexGrow={1}
				minHeight={6}
			>
				{visibleEntries.length === 0 ? (
					<Box justifyContent="center" alignItems="center" flexGrow={1}>
						{showAnimations ? (
							<ThinkingVisualizer
								label={`Thinking${dots}`}
								width={visualiserWidth}
								height={6}
								active
							/>
						) : (
							<Text dimColor>Thinking…</Text>
						)}
					</Box>
				) : (
					visibleEntries.map((entry, i) => {
						const isActive = !entry.done && i === visibleEntries.length - 1;
						const timeStr = entry.durationMs
							? entry.durationMs < 1000
								? `${entry.durationMs}ms`
								: `${(entry.durationMs / 1000).toFixed(1)}s`
							: "";

						return (
							<Box key={entry.id}>
								{/* Status indicator */}
								<Text color={entry.done ? (entry.color === "red" ? "red" : "green") : entry.color}>
									{entry.done ? (entry.color === "red" ? "✗" : "✓") : isActive ? scanBar : "·"}{" "}
								</Text>

								{/* Action tag */}
								<Box width={7}>
									<Text color={entry.color} bold={isActive}>
										{entry.action}
									</Text>
								</Box>

								{/* Detail */}
								<Box flexGrow={1} flexShrink={1}>
									<Text dimColor={entry.done} bold={isActive} wrap="truncate">
										{entry.detail}
									</Text>
								</Box>

								{/* Duration */}
								{timeStr && <Text dimColor> {timeStr}</Text>}
							</Box>
						);
					})
				)}
			</Box>

			{/* Footer — current action */}
			<Box marginTop={0}>
				<Text color="cyan" bold>
					└─{" "}
				</Text>
				{activeTool ? (
					<Text bold>
						{toolToActivity(activeTool, {}).icon} {activeTool}
						{showAnimations ? dots : ""}
					</Text>
				) : (
					<Text dimColor>{showAnimations ? `Reasoning${dots}` : "Reasoning…"}</Text>
				)}
			</Box>
		</Box>
	);
}
