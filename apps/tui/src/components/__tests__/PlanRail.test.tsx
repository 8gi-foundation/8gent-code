/**
 * PlanRail tests - pure presentation. Walks the React element tree
 * returned by calling the component as a function.
 *
 * Pattern matches ActivityRail.test.tsx + ContextRail.test.tsx.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import type { Task } from "../../../../../packages/tasks/index.js";
import { PlanRail, type PlanRailProps } from "../PlanRail.js";

function mkTask(overrides: Partial<Task> = {}): Task {
	const now = new Date().toISOString();
	return {
		id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
		subject: overrides.subject ?? "untitled",
		description: overrides.description ?? "",
		status: overrides.status ?? "pending",
		priority: overrides.priority ?? "medium",
		owner: overrides.owner,
		blockedBy: overrides.blockedBy ?? [],
		blocks: overrides.blocks ?? [],
		parentId: overrides.parentId,
		subtasks: overrides.subtasks ?? [],
		tags: overrides.tags ?? [],
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		completedAt: overrides.completedAt,
		dueDate: overrides.dueDate,
		estimatedMinutes: overrides.estimatedMinutes,
		actualMinutes: overrides.actualMinutes,
		notes: overrides.notes ?? [],
		metadata: overrides.metadata ?? {},
	};
}

function render(props: PlanRailProps): React.ReactElement | null {
	return (PlanRail as (p: PlanRailProps) => React.ReactElement | null)(props);
}

function collectText(node: React.ReactNode): string[] {
	const out: string[] = [];
	const visit = (n: React.ReactNode): void => {
		if (n === null || n === undefined || n === false) return;
		if (typeof n === "string" || typeof n === "number") {
			out.push(String(n));
			return;
		}
		if (Array.isArray(n)) {
			for (const child of n) visit(child);
			return;
		}
		if (React.isValidElement(n)) {
			const props = n.props as { children?: React.ReactNode };
			visit(props.children);
		}
	};
	visit(node);
	return out;
}

describe("PlanRail", () => {
	test("exports the component and types", () => {
		expect(PlanRail).toBeDefined();
		expect(typeof PlanRail).toBe("function");
	});

	test("renders 'no tasks yet' on an empty list", () => {
		const tree = render({ tasks: [] });
		const text = collectText(tree).join(" ");
		expect(text).toContain("PLAN");
		expect(text).toContain("no tasks yet");
	});

	test("renders an in_progress task with the dot icon", () => {
		const tree = render({
			tasks: [mkTask({ subject: "wire up plan rail", status: "in_progress" })],
		});
		const text = collectText(tree).join(" ");
		expect(text).toContain("wire up plan rail");
		expect(text).toContain("●");
	});

	test("sorts in_progress before pending before completed", () => {
		const now = Date.now();
		const tree = render({
			tasks: [
				mkTask({ subject: "finished thing", status: "completed", completedAt: new Date(now).toISOString() }),
				mkTask({ subject: "waiting thing", status: "pending" }),
				mkTask({ subject: "doing thing", status: "in_progress" }),
			],
		});
		const text = collectText(tree).join(" ");
		const doingIdx = text.indexOf("doing thing");
		const waitingIdx = text.indexOf("waiting thing");
		const finishedIdx = text.indexOf("finished thing");
		expect(doingIdx).toBeGreaterThanOrEqual(0);
		expect(waitingIdx).toBeGreaterThan(doingIdx);
		expect(finishedIdx).toBeGreaterThan(waitingIdx);
	});

	test("respects the limit prop", () => {
		const tasks = Array.from({ length: 15 }, (_, i) =>
			mkTask({ subject: `task ${i}`, updatedAt: new Date(Date.now() + i).toISOString() }),
		);
		const tree = render({ tasks, limit: 3 });
		const text = collectText(tree).join(" ");
		expect(text).toContain("task 14");
		expect(text).not.toContain("task 11");
	});

	test("returns null when visible=false", () => {
		const tree = render({
			tasks: [mkTask({ subject: "invisible" })],
			visible: false,
		});
		expect(tree).toBeNull();
	});

	test("includes a counts summary line when tasks exist", () => {
		const tree = render({
			tasks: [
				mkTask({ subject: "a", status: "in_progress" }),
				mkTask({ subject: "b", status: "pending" }),
			],
		});
		const text = collectText(tree).join(" ");
		expect(text).toContain("doing");
		expect(text).toContain("next");
	});

	test("truncates long subjects with an ellipsis", () => {
		const tree = render({
			tasks: [mkTask({ subject: "an extremely long task name that goes way over the limit" })],
		});
		const text = collectText(tree).join(" ");
		expect(text).toContain("…");
	});
});
