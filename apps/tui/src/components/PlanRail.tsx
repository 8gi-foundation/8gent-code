/**
 * PlanRail - always-visible living plan in the right rail.
 *
 * Two exports:
 *  - `PlanRail`     : pure presentation. Receives the task array as a prop.
 *                     Matches ActivityRail/ContextRail pattern, fully unit
 *                     testable by calling the component as a function.
 *  - `LivePlanRail` : wrapper that subscribes to a TaskManager EventEmitter
 *                     and re-renders on every task mutation. App-side mount
 *                     uses this; tests target the pure component.
 *
 * Symmetry with /goal: the autonomous loop has its own state machine +
 * ledger + LiveFocalStripWithGoal overlay. The conversational agent
 * uses the task system + this rail. Same shape (a persistent journey
 * with status), different surface.
 *
 * BRAND.md: orange for in-progress, teal for completed-today, muted for
 * pending. Zero purple/pink/violet. No vendor-name copy.
 */

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { Task, TaskManager } from "../../../../packages/tasks/index.js";
import { t } from "../theme.js";

// ─── Pure presentation ─────────────────────────────────────────────────────

export interface PlanRailProps {
	tasks: ReadonlyArray<Task>;
	limit?: number;
	compact?: boolean;
	visible?: boolean;
}

const STATUS_ICON: Record<Task["status"], string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
	blocked: "!",
	cancelled: "✗",
};

function statusColor(status: Task["status"]): string {
	switch (status) {
		case "in_progress":
			return t.orange;
		case "completed":
			return t.teal;
		case "blocked":
			return t.red;
		case "cancelled":
			return t.textDim;
		default:
			return t.textTertiary;
	}
}

const STATUS_RANK: Record<Task["status"], number> = {
	in_progress: 0,
	pending: 1,
	blocked: 2,
	completed: 3,
	cancelled: 4,
};

function planOrder(a: Task, b: Task): number {
	const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
	if (r !== 0) return r;
	return b.updatedAt.localeCompare(a.updatedAt);
}

function isStaleCompleted(task: Task): boolean {
	if (task.status !== "completed") return false;
	if (!task.completedAt) return false;
	const ageMs = Date.now() - new Date(task.completedAt).getTime();
	return ageMs > 24 * 60 * 60 * 1000;
}

function counts(tasks: ReadonlyArray<Task>): string {
	let inProgress = 0;
	let pending = 0;
	let blocked = 0;
	let completedToday = 0;
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	for (const task of tasks) {
		if (task.status === "in_progress") inProgress += 1;
		else if (task.status === "pending") pending += 1;
		else if (task.status === "blocked") blocked += 1;
		else if (task.status === "completed" && task.completedAt) {
			if (new Date(task.completedAt).getTime() >= dayAgo) completedToday += 1;
		}
	}
	return `${inProgress} doing · ${pending} next · ${blocked} blocked · ${completedToday} done today`;
}

export function PlanRail({
	tasks,
	limit = 8,
	compact = false,
	visible = true,
}: PlanRailProps): React.ReactElement | null {
	if (!visible) return null;

	const ranked = [...tasks].sort(planOrder).slice(0, limit);

	return (
		<Box flexDirection="column" width={compact ? 18 : 24} flexShrink={0} paddingX={1}>
			<Text color={t.orange} bold>
				PLAN
			</Text>
			<Box marginTop={1} flexDirection="column">
				{ranked.length === 0 ? (
					<Text color={t.textDim}>(no tasks yet)</Text>
				) : (
					ranked.map((task) => {
						const icon = STATUS_ICON[task.status];
						const color = statusColor(task.status);
						const subjectMax = compact ? 14 : 20;
						const subject =
							task.subject.length > subjectMax
								? `${task.subject.slice(0, subjectMax - 1)}…`
								: task.subject;
						const dim = isStaleCompleted(task);
						return (
							<Box key={task.id}>
								<Text color={color}>{icon} </Text>
								<Text color={dim ? t.textDim : t.textPrimary}>{subject}</Text>
							</Box>
						);
					})
				)}
			</Box>
			{ranked.length > 0 ? (
				<Box marginTop={1}>
					<Text color={t.textDim}>{counts(tasks)}</Text>
				</Box>
			) : null}
		</Box>
	);
}

// ─── Live wrapper (mount this from app.tsx) ────────────────────────────────

export interface LivePlanRailProps {
	manager: TaskManager;
	limit?: number;
	compact?: boolean;
	visible?: boolean;
}

export function LivePlanRail({
	manager,
	limit,
	compact,
	visible,
}: LivePlanRailProps): React.ReactElement | null {
	const [tasks, setTasks] = useState<ReadonlyArray<Task>>(() => snapshot(manager));

	useEffect(() => {
		const onChange = (): void => setTasks(snapshot(manager));
		manager.on("task:created", onChange);
		manager.on("task:updated", onChange);
		manager.on("task:completed", onChange);
		manager.on("task:blocked", onChange);
		manager.on("task:unblocked", onChange);
		manager.on("task:deleted", onChange);
		return () => {
			manager.off("task:created", onChange);
			manager.off("task:updated", onChange);
			manager.off("task:completed", onChange);
			manager.off("task:blocked", onChange);
			manager.off("task:unblocked", onChange);
			manager.off("task:deleted", onChange);
		};
	}, [manager]);

	return <PlanRail tasks={tasks} limit={limit} compact={compact} visible={visible} />;
}

function snapshot(manager: TaskManager): Task[] {
	try {
		return manager.listTasks();
	} catch {
		return [];
	}
}
