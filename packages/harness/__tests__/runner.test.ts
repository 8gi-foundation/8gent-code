/**
 * HarnessRunner - the task manager behind the HTTP surface (part of #2797).
 *
 * Covers:
 *   - start() returns a taskId immediately and runs detached
 *   - events are buffered per task and retrievable via getEvents()
 *   - subscribe() receives live events; unsubscribe stops delivery
 *   - unknown harness name throws synchronously at start()
 *   - the runner defaults to the 8gent-local registry
 */

import { describe, expect, it } from "bun:test";
import { type Harness, HarnessRegistry, type StatusEvent } from "../index";
import { HarnessRunner } from "../runner";

function instantHarness(name: string): Harness {
	return {
		name,
		async *run(task): AsyncIterable<StatusEvent> {
			const base = { agentId: task.id, harness: name, ts: Date.now() };
			yield { ...base, state: "queued" };
			yield { ...base, state: "working" };
			yield { ...base, state: "done", output: `finished:${task.prompt}` };
		},
	};
}

function testRunner(): HarnessRunner {
	const registry = new HarnessRegistry();
	registry.register(instantHarness("8gent-local"));
	registry.register(instantHarness("other"));
	return new HarnessRunner(registry);
}

async function waitForDone(runner: HarnessRunner, taskId: string): Promise<StatusEvent[]> {
	for (let i = 0; i < 200; i++) {
		const events = runner.getEvents(taskId);
		const last = events[events.length - 1];
		if (last && (last.state === "done" || last.state === "error")) return events;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`task ${taskId} never reached a terminal state`);
}

describe("HarnessRunner", () => {
	it("start() returns a taskId string immediately", () => {
		const runner = testRunner();
		const taskId = runner.start({ prompt: "hello" });
		expect(typeof taskId).toBe("string");
		expect(taskId.length).toBeGreaterThan(0);
	});

	it("buffers the full event history per task", async () => {
		const runner = testRunner();
		const taskId = runner.start({ prompt: "hello" });
		const events = await waitForDone(runner, taskId);
		expect(events.map((e) => e.state)).toEqual(["queued", "working", "done"]);
		expect(events[2]?.output).toBe("finished:hello");
		for (const e of events) expect(e.agentId).toBe(taskId);
	});

	it("routes to the named harness and defaults to 8gent-local", async () => {
		const runner = testRunner();
		const defaultTask = runner.start({ prompt: "a" });
		const namedTask = runner.start({ prompt: "b", harness: "other" });
		const defaultEvents = await waitForDone(runner, defaultTask);
		const namedEvents = await waitForDone(runner, namedTask);
		expect(defaultEvents[0]?.harness).toBe("8gent-local");
		expect(namedEvents[0]?.harness).toBe("other");
	});

	it("throws synchronously for an unknown harness", () => {
		const runner = testRunner();
		expect(() => runner.start({ prompt: "x", harness: "devin" })).toThrow(/devin/);
	});

	it("delivers live events to subscribers and honours unsubscribe", async () => {
		const runner = testRunner();
		const seen: StatusEvent[] = [];
		const unsubscribe = runner.subscribe((e) => seen.push(e));
		const taskId = runner.start({ prompt: "live" });
		await waitForDone(runner, taskId);
		expect(seen.length).toBe(3);
		expect(seen[seen.length - 1]?.state).toBe("done");

		unsubscribe();
		const secondTask = runner.start({ prompt: "after-unsub" });
		await waitForDone(runner, secondTask);
		expect(seen.length).toBe(3); // nothing new after unsubscribe
	});

	it("getEvents returns [] for an unknown task", () => {
		const runner = testRunner();
		expect(runner.getEvents("nope")).toEqual([]);
	});

	it("defaults to a registry with 8gent-local registered", () => {
		const runner = new HarnessRunner();
		expect(runner.registry.list()).toContain("8gent-local");
	});
});
