/**
 * #153: a finished task with no result text is reported as such, never as
 * the bare word "Done". A task the registry marks failed is reported failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cos-no-done-"));
const prior = process.env.EIGHT_DATA_DIR;
let CoSRouter: typeof import("./cos-router").CoSRouter;
let bus: typeof import("./events").bus;
let createTask: typeof import("./task-registry").createTask;
let updateTask: typeof import("./task-registry").updateTask;

beforeAll(async () => {
	process.env.EIGHT_DATA_DIR = dir;
	({ CoSRouter } = await import("./cos-router"));
	({ bus } = await import("./events"));
	({ createTask, updateTask } = await import("./task-registry"));
});

afterAll(() => {
	if (prior === undefined) process.env.EIGHT_DATA_DIR = undefined;
	else process.env.EIGHT_DATA_DIR = prior;
	rmSync(dir, { recursive: true, force: true });
});

function capture(): string[] {
	const sent: string[] = [];
	new CoSRouter({
		pool: {} as never,
		notifications: {
			notify: async (_type: string, message: string) => {
				sent.push(message);
			},
		} as never,
	});
	return sent;
}

describe("task-complete notification without a result", () => {
	test("an empty result says no result was returned, not Done", () => {
		const sent = capture();
		bus.emit("task:completed", {
			taskId: "t-empty",
			description: "Tidy docs",
			result: "",
			sessionId: "s",
		});
		const msg = sent[sent.length - 1] ?? "";
		expect(msg).toContain("returned no result");
		expect(msg).not.toMatch(/\bdone\b/i);
	});

	test("a task the registry marks failed is reported failed", () => {
		const task = createTask("Break things", "p1" as never);
		updateTask(task.id, { status: "failed" });
		const sent = capture();
		bus.emit("task:completed", {
			taskId: task.id,
			description: "Break things",
			result: "",
			sessionId: "s",
		});
		const msg = sent[sent.length - 1] ?? "";
		expect(msg).toContain("failed");
		expect(msg).not.toMatch(/\bdone\b/i);
	});

	test("a real result is still shown as given", () => {
		const sent = capture();
		bus.emit("task:completed", {
			taskId: "t-ok",
			description: "Ship",
			result: "PR 12 opened",
			sessionId: "s",
		});
		expect(sent[sent.length - 1]).toContain("Result: PR 12 opened");
	});
});
