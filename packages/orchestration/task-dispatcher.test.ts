import { describe, it, expect } from "bun:test";
import { TaskDispatcher } from "./task-dispatcher.js";

describe("TaskDispatcher", () => {
	it("only one role can claim a task", () => {
		const d = new TaskDispatcher();
		d.enqueue("task-1", "Fix bug");
		const r1 = d.claim("task-1", "engineer");
		const r2 = d.claim("task-1", "qa");
		expect(r1).not.toBeNull();
		expect(r2).toBeNull();
		expect(r1!.claimedBy).toBe("engineer");
	});

	it("releaseStalled releases ghost claims", () => {
		const d = new TaskDispatcher();
		d.enqueue("task-2", "Review");
		const task = d.claim("task-2", "qa")!;
		// backdate the claim
		task.claimedAt = Date.now() - 21 * 60 * 1000;
		const released = d.releaseStalled();
		expect(released).toContain("task-2");
		expect(task.state).toBe("pending");
	});
});
