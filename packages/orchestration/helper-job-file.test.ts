import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentPool, type SpawnedAgent } from "./index";

let dir: string;
const saved = process.env.EIGHT_JOBS_DIR;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "helperjob-"));
	process.env.EIGHT_JOBS_DIR = dir;
});
afterEach(() => {
	if (saved === undefined) delete process.env.EIGHT_JOBS_DIR;
	else process.env.EIGHT_JOBS_DIR = saved;
	fs.rmSync(dir, { recursive: true, force: true });
});

function fake(status: SpawnedAgent["status"], error?: string): SpawnedAgent {
	return {
		id: "agent-1",
		status,
		startedAt: new Date("2026-10-25T10:00:00Z"),
		completedAt: status === "completed" || status === "failed" ? new Date() : undefined,
		task: { description: "tidy the docs", error },
	} as unknown as SpawnedAgent;
}
const read = () => JSON.parse(fs.readFileSync(path.join(dir, "helper-agent-1.json"), "utf8"));

test("a background run's row follows the pool's own events", () => {
	const pool = new AgentPool();
	pool.emit("agent:spawned", fake("idle"));
	expect(read().state).toBe("queued");
	pool.emit("agent:started", fake("running"));
	expect(read().state).toBe("running");
	expect(read().detail).toBe("tidy the docs");
	pool.emit("agent:completed", fake("completed"));
	expect(read().state).toBe("done");
});

test("a failed run waits on the owner", () => {
	const pool = new AgentPool();
	pool.emit("agent:failed", fake("failed", "model unreachable"));
	expect(read().state).toBe("waiting-on-you");
	expect(read().waitingOn).toContain("model unreachable");
});
