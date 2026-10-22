/**
 * background_wait (#4284): block until a promoted or started background task ends.
 * Real processes, no mocks: the path that ships is startTask -> waitForTask -> format.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools, setToolContext } from "../ai/tools";
import { ToolExecutor } from "../eight/tools";
import {
	BackgroundTaskManager,
	getBackgroundTaskManager,
	waitForBackgroundTask,
} from "./background";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bg-wait-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("waitForBackgroundTask", () => {
	test("returns exit code and output tail once the task finishes", async () => {
		const mgr = new BackgroundTaskManager(dir);
		const id = mgr.startTask("echo hello-wait; sleep 0.3; exit 3", { workingDirectory: dir });
		const out = await waitForBackgroundTask(mgr, id, 10);
		expect(out).toContain("[FINISHED failed, exit code 3]");
		expect(out).toContain("hello-wait");
	});

	test("a zero exit reports completed", async () => {
		const mgr = new BackgroundTaskManager(dir);
		const id = mgr.startTask("echo ok", { workingDirectory: dir });
		const out = await waitForBackgroundTask(mgr, id, 10);
		expect(out).toContain("[FINISHED completed, exit code 0]");
	});

	test("hitting the timeout says STILL RUNNING and names the tool to call again", async () => {
		const mgr = new BackgroundTaskManager(dir);
		const id = mgr.startTask("sleep 30", { workingDirectory: dir });
		const t0 = Date.now();
		const out = await waitForBackgroundTask(mgr, id, 1);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(out).toContain("[STILL RUNNING after 1s]");
		expect(out).toContain(`background_wait("${id}")`);
		mgr.killTask(id);
	});

	test("unknown id and bad timeout are handled", async () => {
		const mgr = new BackgroundTaskManager(dir);
		expect(await waitForBackgroundTask(mgr, "nope", 1)).toBe("Task not found: nope");
		const id = mgr.startTask("echo fast", { workingDirectory: dir });
		expect(await waitForBackgroundTask(mgr, id, Number.NaN)).toContain("[FINISHED completed");
	});
});

describe("background_wait is wired on both tool paths", () => {
	test("ToolExecutor.execute waits on a task it can see", async () => {
		const ex = new ToolExecutor(dir);
		const id = getBackgroundTaskManager(dir).startTask("sleep 0.3; echo via-executor", {
			workingDirectory: dir,
		});
		const out = (await ex.execute("background_wait", { taskId: id, timeout_s: 10 })) as string;
		expect(out).toContain("[FINISHED completed, exit code 0]");
		expect(out).toContain("via-executor");
	});

	test("AI SDK tool waits and its first sentence states the input shape", async () => {
		setToolContext({ workingDirectory: dir } as Parameters<typeof setToolContext>[0]);
		const t = agentTools.background_wait as unknown as {
			description: string;
			execute: (i: unknown, o: unknown) => Promise<string>;
		};
		expect(t.description.slice(0, 140)).toContain("taskId and timeout_s");
		const id = getBackgroundTaskManager(dir).startTask("echo via-sdk", { workingDirectory: dir });
		const out = await t.execute({ taskId: id, timeout_s: 10 }, { toolCallId: "w", messages: [] });
		expect(out).toContain("via-sdk");
	});
});
