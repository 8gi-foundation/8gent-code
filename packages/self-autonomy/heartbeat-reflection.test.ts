/**
 * Verify the heartbeat agent triggers reflection between iterations.
 * Uses triggerReflection() directly so we don't depend on setInterval timing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getRecentReflections, resetDb } from "./evolution-db";
import { HeartbeatAgents, resetHeartbeatAgents } from "./heartbeat";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-reflect-"));
	process.env.EIGHT_DATA_DIR = tmpDir;
	resetDb();
	resetHeartbeatAgents();
});

afterEach(() => {
	resetHeartbeatAgents();
	resetDb();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	process.env.EIGHT_DATA_DIR = undefined;
});

describe("HeartbeatAgents reflection wiring", () => {
	it("reportToolCall + triggerReflection persists a SessionReflection", () => {
		const heartbeat = new HeartbeatAgents({ workingDirectory: tmpDir });

		heartbeat.reportToolCall("read_file", true);
		heartbeat.reportToolCall("edit_file", true);
		heartbeat.reportToolCall("bash", false);
		heartbeat.reportNote("PATTERN: read before edit");
		heartbeat.reportNote("SKILL: prefer-relative-paths");

		const reflection = heartbeat.triggerReflection();

		expect(reflection).not.toBeNull();
		expect(reflection!.toolsUsed).toContain("read_file");
		expect(reflection!.toolsUsed).toContain("edit_file");
		expect(reflection!.successRate).toBeCloseTo(2 / 3, 2);
		expect(reflection!.skillsLearned).toContain("prefer-relative-paths");

		// Persisted in DB
		const recent = getRecentReflections(5);
		expect(recent.length).toBe(1);
		expect(recent[0].sessionId).toBe(reflection!.sessionId);
	});

	it("triggerReflection returns null when nothing has been reported", () => {
		const heartbeat = new HeartbeatAgents({ workingDirectory: tmpDir });
		const reflection = heartbeat.triggerReflection();
		expect(reflection).toBeNull();
	});

	it("emits reflection:complete event", () => {
		const heartbeat = new HeartbeatAgents({ workingDirectory: tmpDir });
		let received: { reflection: unknown } | null = null;
		heartbeat.on("reflection:complete", (payload: any) => {
			received = payload;
		});

		heartbeat.reportToolCall("Read", true);
		heartbeat.triggerReflection();

		expect(received).not.toBeNull();
		expect(received).toHaveProperty("reflection");
	});

	it("resets the accumulator after a successful reflection", () => {
		const heartbeat = new HeartbeatAgents({ workingDirectory: tmpDir });
		heartbeat.reportToolCall("Read", true);
		heartbeat.triggerReflection();

		// Second call with no new activity should now return null.
		const second = heartbeat.triggerReflection();
		expect(second).toBeNull();
	});
});
