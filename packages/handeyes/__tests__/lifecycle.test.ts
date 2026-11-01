/**
 * Lifecycle tests per spec §4.1.
 *
 * Phase 1 (trigger fires) is covered in triggers.test.ts. This file covers:
 *   - Phase 2: workers spawned exactly once per session
 *   - Phase 3: forward-progress streak detection
 *   - Phase 4: every documented exit path tears down workers
 *   - Spawn failure: handle is NOT created and cooldown is NOT set
 *   - Idempotency on engage and exit
 */

import { describe, expect, it } from "bun:test";
import {
	EngagementLoop,
	type EngagementLoopHooks,
	FORWARD_PROGRESS_EXIT_STREAK,
	type SessionExitedPayload,
	type SessionWorkers,
} from "../engagement-loop.js";

interface SpawnRecord {
	spawned: number;
	tornDown: number;
	last?: SessionWorkers;
}

function recordingHooks(rec: SpawnRecord, opts: { failSpawn?: boolean } = {}): EngagementLoopHooks {
	return {
		spawnSession: async (): Promise<SessionWorkers> => {
			if (opts.failSpawn) throw new Error("spawn failed");
			rec.spawned += 1;
			const workers: SessionWorkers = {
				teardown: async () => {
					rec.tornDown += 1;
				},
			};
			rec.last = workers;
			return workers;
		},
	};
}

describe("session lifecycle", () => {
	it("spawns workers exactly once per engagement", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 4 });
		await loop.engage("explicit_self_diagnosis");
		expect(rec.spawned).toBe(1);
		await loop.exitExplicit();
		expect(rec.tornDown).toBe(1);
	});

	it("engage on an already-active session returns the existing handle", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec) });
		const a = await loop.engage("explicit_self_diagnosis");
		const b = await loop.engage("explicit_self_diagnosis");
		expect(a.id).toBe(b.id);
		expect(rec.spawned).toBe(1);
		await loop.dispose();
	});

	it("auto-exits after FORWARD_PROGRESS_EXIT_STREAK consecutive forward steps", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 16 });
		const exits: SessionExitedPayload[] = [];
		loop.on("session:exited", (p) => exits.push(p));

		await loop.engage("explicit_self_diagnosis");
		for (let i = 0; i < FORWARD_PROGRESS_EXIT_STREAK; i++) {
			await loop.step(true);
		}
		expect(loop.current()).toBeNull();
		expect(exits).toHaveLength(1);
		expect(exits[0].reason).toBe("forward_progress_streak");
		expect(rec.tornDown).toBe(1);
	});

	it("resets streak on a non-progress step", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 16 });
		await loop.engage("explicit_self_diagnosis");
		await loop.step(true);
		await loop.step(true);
		await loop.step(false); // streak reset
		await loop.step(true);
		await loop.step(true);
		// Still not at streak=3, so still active.
		expect(loop.current()).not.toBeNull();
		await loop.step(true);
		expect(loop.current()).toBeNull();
		await loop.dispose();
	});

	it("auto-exits when ttl is exhausted", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 2 });
		const exits: SessionExitedPayload[] = [];
		loop.on("session:exited", (p) => exits.push(p));
		await loop.engage("explicit_self_diagnosis");
		await loop.step(false);
		await loop.step(false);
		expect(loop.current()).toBeNull();
		expect(exits[0].reason).toBe("ttl_exhausted");
		expect(rec.tornDown).toBe(1);
	});

	it("subagent failure tears down workers and clears state", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 8 });
		const exits: SessionExitedPayload[] = [];
		loop.on("session:exited", (p) => exits.push(p));
		await loop.engage("explicit_self_diagnosis");
		await loop.failSubagent();
		expect(loop.current()).toBeNull();
		expect(exits[0].reason).toBe("subagent_error");
		expect(rec.tornDown).toBe(1);
	});

	it("spawn failure does not create a handle and does not set cooldown", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({
			hooks: recordingHooks(rec, { failSpawn: true }),
			defaultTtlSteps: 4,
			postExitCooldownMs: 999_999,
		});
		await expect(loop.engage("explicit_self_diagnosis")).rejects.toThrow("spawn failed");
		expect(loop.current()).toBeNull();
		// Second attempt should still be allowed (no cooldown latched).
		await expect(loop.engage("explicit_self_diagnosis")).rejects.toThrow("spawn failed");
		await loop.dispose();
	});

	it("dispose tears down an active session and removes listeners", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec) });
		const seen: string[] = [];
		loop.on("session:exited", () => seen.push("exit"));
		await loop.engage("explicit_self_diagnosis");
		await loop.dispose();
		expect(rec.tornDown).toBe(1);
		expect(seen).toEqual(["exit"]);
		// Subsequent emit should not reach old listener.
		loop.emit("session:exited", null as unknown as never);
		expect(seen).toEqual(["exit"]);
	});

	it("step on no-active-session is a no-op", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec) });
		const out = await loop.step(true);
		expect(out).toBeNull();
	});

	it("explicit exit on a foreign handle is a no-op", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec) });
		const handle = await loop.engage("explicit_self_diagnosis");
		await loop.exitExplicit({ ...handle, id: "different-id" });
		expect(loop.current()).not.toBeNull();
		await loop.exitExplicit(handle);
		expect(loop.current()).toBeNull();
	});

	it("decrements ttlSteps on the live handle as steps advance", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 3 });
		const handle = await loop.engage("explicit_self_diagnosis");
		expect(handle.ttlSteps).toBe(3);
		await loop.step(false);
		expect(handle.ttlSteps).toBe(2);
		await loop.step(false);
		expect(handle.ttlSteps).toBe(1);
		await loop.dispose();
	});

	it("emits session:step with payload describing forward progress and streak", async () => {
		const rec: SpawnRecord = { spawned: 0, tornDown: 0 };
		const loop = new EngagementLoop({ hooks: recordingHooks(rec), defaultTtlSteps: 8 });
		const steps: { forwardProgress: boolean; streak: number }[] = [];
		loop.on("session:step", (p) => steps.push({ forwardProgress: p.forwardProgress, streak: p.streak }));
		await loop.engage("explicit_self_diagnosis");
		await loop.step(true);
		await loop.step(false);
		await loop.step(true);
		expect(steps).toEqual([
			{ forwardProgress: true, streak: 1 },
			{ forwardProgress: false, streak: 0 },
			{ forwardProgress: true, streak: 1 },
		]);
		await loop.dispose();
	});
});
