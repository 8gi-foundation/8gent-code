/**
 * Tests for LifecycleManager: state machine, suspend/resume, queue, shutdown.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ALLOWED_TRANSITIONS, isValidTransition } from "@8gent/types";
import { MemorySink, setSink, resetSinkToStdout, isLifecycleEvent } from "@8gent/telemetry";

import { LifecycleManager, type ExecutorContext } from "./agent-lifecycle";

let tempDir: string;
let sink: MemorySink;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
	sink = new MemorySink();
	setSink(sink);
});

afterEach(() => {
	resetSinkToStdout();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function newManager(opts: { maxConcurrent?: number } = {}) {
	return new LifecycleManager({
		maxConcurrent: opts.maxConcurrent,
		snapshotDir: tempDir,
		defaultTenantId: "test-tenant",
	});
}

describe("AgentLifecycleState transitions", () => {
	test("allowed transitions are documented", () => {
		expect(isValidTransition("spawning", "running")).toBe(true);
		expect(isValidTransition("running", "suspended")).toBe(true);
		expect(isValidTransition("suspended", "resumed")).toBe(true);
		expect(isValidTransition("resumed", "running")).toBe(true);
		expect(isValidTransition("running", "completed")).toBe(true);
		expect(isValidTransition("running", "failed")).toBe(true);
		expect(isValidTransition("running", "terminated")).toBe(true);
	});

	test("terminal states have no outgoing transitions", () => {
		expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
		expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
		expect(ALLOWED_TRANSITIONS.terminated).toEqual([]);
	});

	test("invalid transitions are rejected", () => {
		expect(isValidTransition("completed", "running")).toBe(false);
		expect(isValidTransition("suspended", "completed")).toBe(false);
		expect(isValidTransition("spawning", "suspended")).toBe(false);
	});
});

describe("LifecycleManager — basic spawn/complete", () => {
	test("spawns an agent and runs to completion", async () => {
		const mgr = newManager();
		const { agentId, done } = mgr.spawn(
			{ taskDescription: "echo hello" },
			async () => "hello",
		);
		const result = await done;
		expect(result).toBe("hello");
		expect(mgr.getAgent(agentId)?.state).toBe("completed");
	});

	test("propagates executor failure to failed state", async () => {
		const mgr = newManager();
		const { done, agentId } = mgr.spawn(
			{ taskDescription: "boom" },
			async () => {
				throw new Error("kaboom");
			},
		);
		await expect(done).rejects.toThrow("kaboom");
		expect(mgr.getAgent(agentId)?.state).toBe("failed");
	});
});

describe("LifecycleManager — suspend/resume round-trip", () => {
	test("suspend mid-task, resume, task completes", async () => {
		const mgr = newManager();
		const work = [1, 2, 3, 4, 5];

		// First run: cooperatively process items, yielding between each so
		// the test can land a suspend request mid-task.
		const executorA = async (ctx: ExecutorContext) => {
			const processed = (ctx.resumeFrom?.checkpoint as { processed?: number[] } | undefined)
				?.processed ?? [];
			for (const item of work) {
				if (processed.includes(item)) continue;
				if (ctx.suspendRequested()) {
					ctx.checkpoint({ processed });
					return;
				}
				processed.push(item);
				ctx.checkpoint({ processed });
				// Yield every iteration so the suspend signal is checked.
				await new Promise((r) => setTimeout(r, 20));
			}
			return processed;
		};

		const { agentId } = mgr.spawn(
			{ taskDescription: "process work", agentId: "wk-1" },
			executorA,
		);

		// Wait for the agent to land a few items, then suspend.
		// `done` does not resolve on suspend (it's not a terminal state),
		// so we wait on `suspend()` which resolves once the snapshot is on disk.
		await new Promise((r) => setTimeout(r, 30));
		const snapshot = await mgr.suspend(agentId);

		expect(snapshot.state).toBe("suspended");
		expect(mgr.getAgent(agentId)?.state).toBe("suspended");
		expect(fs.existsSync(mgr.snapshotPath(agentId))).toBe(true);

		const persisted = mgr.loadSnapshot(agentId);
		expect(persisted).not.toBeNull();
		expect((persisted!.checkpoint as { processed: number[] }).processed.length).toBeGreaterThan(0);

		// Second run: resume and finish the rest.
		const executorB = async (ctx: ExecutorContext) => {
			const processed = (ctx.resumeFrom?.checkpoint as { processed: number[] }).processed.slice();
			for (const item of work) {
				if (processed.includes(item)) continue;
				processed.push(item);
				ctx.checkpoint({ processed });
			}
			return processed;
		};

		// New manager (simulates process restart) reading from the same snapshot dir.
		const mgr2 = newManager();
		const { done: doneB } = mgr2.resume(agentId, executorB);
		const final = (await doneB) as number[];
		expect(final.sort()).toEqual([1, 2, 3, 4, 5]);
		expect(mgr2.getAgent(agentId)?.state).toBe("completed");
	});

	test("resume rejects when no snapshot exists", () => {
		const mgr = newManager();
		expect(() => mgr.resume("does-not-exist", async () => undefined)).toThrow();
	});
});

describe("LifecycleManager — pool and priority queue", () => {
	test("excess agents are queued and run in priority order", async () => {
		const mgr = newManager({ maxConcurrent: 1 });
		const order: string[] = [];

		const make = (label: string, priority: number) =>
			mgr.spawn(
				{ taskDescription: label, priority, agentId: label },
				async () => {
					await new Promise((r) => setTimeout(r, 5));
					order.push(label);
					return label;
				},
			);

		const a = make("a", 1);
		const b = make("b", 5);
		const c = make("c", 3);
		const d = make("d", 10);

		await Promise.all([a.done, b.done, c.done, d.done]);

		// `a` started immediately at the time of spawn (took the only slot).
		// Then queue drains by priority desc: d (10) -> b (5) -> c (3).
		expect(order[0]).toBe("a");
		expect(order.slice(1)).toEqual(["d", "b", "c"]);
		const stats = mgr.getStats();
		expect(stats.completed).toBe(4);
		expect(stats.queued).toBe(0);
	});

	test("terminate on a queued agent never runs the executor", async () => {
		const mgr = newManager({ maxConcurrent: 1 });
		let secondRan = false;
		const blocker = mgr.spawn({ taskDescription: "block", agentId: "first" }, async () => {
			await new Promise((r) => setTimeout(r, 30));
			return "first";
		});
		const queued = mgr.spawn(
			{ taskDescription: "queued", agentId: "second" },
			async () => {
				secondRan = true;
				return "second";
			},
		);
		mgr.terminate("second");
		await blocker.done;
		await queued.done;
		expect(secondRan).toBe(false);
		expect(mgr.getAgent("second")?.state).toBe("terminated");
	});
});

describe("LifecycleManager — graceful shutdown", () => {
	test("shutdown suspends all running agents and writes snapshots", async () => {
		const mgr = newManager({ maxConcurrent: 2 });
		const executor = async (ctx: ExecutorContext) => {
			let i = 0;
			while (i < 100) {
				if (ctx.suspendRequested()) {
					ctx.checkpoint({ progress: i });
					return;
				}
				i++;
				await new Promise((r) => setTimeout(r, 1));
			}
			return i;
		};
		mgr.spawn({ taskDescription: "long-1", agentId: "lr-1" }, executor);
		mgr.spawn({ taskDescription: "long-2", agentId: "lr-2" }, executor);

		await new Promise((r) => setTimeout(r, 10));
		const snaps = await mgr.shutdown("test-shutdown");
		expect(snaps.length).toBe(2);
		for (const snap of snaps) {
			expect(snap.state).toBe("suspended");
			expect(fs.existsSync(mgr.snapshotPath(snap.agentId))).toBe(true);
		}
	});
});

describe("LifecycleManager — telemetry", () => {
	test("emits a lifecycle event on every transition", async () => {
		const mgr = newManager();
		const { done } = mgr.spawn({ taskDescription: "tel" }, async () => "ok");
		await done;
		const events = sink.events.filter(isLifecycleEvent);
		const states = events.map((e) => e.state);
		// spawning (initial) -> running -> completed
		expect(states).toContain("spawning");
		expect(states).toContain("running");
		expect(states).toContain("completed");
		for (const e of events) {
			expect(e.tenantId).toBe("test-tenant");
		}
	});
});
