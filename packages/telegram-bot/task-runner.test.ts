import { describe, expect, it } from "bun:test";
import { TaskRunner, type TaskRunnerEvents, renderTaskProgress } from "./task-runner";

interface Capture {
	sent: Array<{ text: string }>;
	edits: Array<{ id: number; text: string }>;
	files: number;
	events: TaskRunnerEvents;
}

function makeCapture(): Capture {
	const sent: Capture["sent"] = [];
	const edits: Capture["edits"] = [];
	let files = 0;
	const events: TaskRunnerEvents = {
		send: async (text) => {
			sent.push({ text });
			return sent.length;
		},
		edit: async (id, text) => {
			edits.push({ id, text });
		},
		sendFile: async () => {
			files++;
		},
	};
	return {
		sent,
		edits,
		get files() {
			return files;
		},
		set files(v) {
			files = v;
		},
		events,
	};
}

describe("TaskRunner", () => {
	it("anchors a single progress message and edits it as steps run", async () => {
		const cap = makeCapture();
		const runner = new TaskRunner(
			{ chatId: "1", sessionId: "s1", description: "Refactor auth flow" },
			cap.events,
			{ editThrottleMs: 0 },
		);

		await runner.start();
		expect(cap.sent.length).toBe(1);
		expect(cap.sent[0].text).toContain("Planning");

		const step1 = runner.addStep("Read src/auth.ts");
		runner.markStepActive(step1.id);
		const step2 = runner.addStep("Edit src/auth.ts");

		await new Promise((r) => setTimeout(r, 5));
		runner.markStepDone(step1.id, "ok");
		runner.markStepActive(step2.id);
		runner.markStepDone(step2.id, "patched");

		await runner.complete("Refactor done.");
		runner.destroy();

		// Edits should have happened on the same anchor message.
		for (const e of cap.edits) expect(e.id).toBe(1);
		// Final edit should reflect the success summary.
		const last = cap.edits[cap.edits.length - 1];
		expect(last?.text).toContain("Done");
		expect(last?.text).toContain("Refactor done.");
	});

	it("delivers queued attachments after completion", async () => {
		const cap = makeCapture();
		const runner = new TaskRunner(
			{ chatId: "1", sessionId: null, description: "Generate diagram" },
			cap.events,
			{ editThrottleMs: 0 },
		);

		await runner.start();
		runner.attachFile({ kind: "photo", buffer: Buffer.from([1, 2, 3]), filename: "diagram.png" });
		runner.attachFile({ kind: "document", buffer: Buffer.from("x"), filename: "out.md" });

		await runner.complete("Here you go.");
		expect(cap.files).toBe(2);
	});

	it("renders failure with retry summary", async () => {
		const cap = makeCapture();
		const runner = new TaskRunner(
			{ chatId: "1", sessionId: null, description: "Run tests" },
			cap.events,
			{ editThrottleMs: 0 },
		);

		await runner.start();
		const s = runner.addStep("npm test");
		runner.markStepActive(s.id);
		await runner.fail("Process exited with code 1");

		const last = cap.edits[cap.edits.length - 1];
		expect(last?.text).toContain("Failed");
		expect(last?.text).toContain("exited with code 1");
	});

	it("cancels all pending and active steps", async () => {
		const cap = makeCapture();
		const runner = new TaskRunner(
			{ chatId: "1", sessionId: null, description: "Long job" },
			cap.events,
			{ editThrottleMs: 0 },
		);
		await runner.start();
		const s1 = runner.addStep("step-1");
		const s2 = runner.addStep("step-2");
		runner.markStepActive(s1.id);
		await runner.cancel("user pressed Cancel");

		expect(runner.task.status).toBe("cancelled");
		expect(runner.task.steps.find((s) => s.id === s1.id)?.status).toBe("skipped");
		expect(runner.task.steps.find((s) => s.id === s2.id)?.status).toBe("skipped");
	});

	it("renderTaskProgress is deterministic for completed tasks", () => {
		const text = renderTaskProgress({
			id: "task_1",
			chatId: "1",
			sessionId: null,
			description: "demo",
			status: "succeeded",
			steps: [
				{ id: "a", label: "first", status: "done", summary: "ok" },
				{ id: "b", label: "second", status: "done" },
			],
			attachments: [],
			startedAt: 0,
			completedAt: 2500,
			finalText: "all good",
		});
		expect(text).toContain("Done");
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(text).toContain("all good");
	});
});
