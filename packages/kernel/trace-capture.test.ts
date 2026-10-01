import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { KernelManager } from "./manager";
import { TraceCapture, type Trajectory } from "./trace-capture";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
afterAll(cleanupTempDirs);

function freshRoot(): string {
	return tempDir("trace-capture-");
}

const TURN = {
	sessionId: "s1",
	turnIndex: 1,
	model: "eight-1.0-q3:14b",
	prompt: "add a retry to the fetch helper",
	response: "Added exponential backoff with three retries to fetchWithRetry.",
	score: 0.9,
};

describe("TraceCapture opt-in gate", () => {
	test("is OFF by default and writes nothing", () => {
		const root = freshRoot();
		const capture = new TraceCapture(root);

		expect(capture.enabled).toBe(false);
		capture.recordToolStep({ tool: "edit_file", argsSummary: '{"path":"a.ts"}', ok: true });
		const out = capture.finalizeTurn(TURN);

		expect(out).toBeNull();
		expect(existsSync(join(root, ".8gent", "kernel", "traces", "trajectories.jsonl"))).toBe(false);
	});

	test("captures and persists a trajectory when opted in", () => {
		const root = freshRoot();
		const capture = new TraceCapture(root, true);

		capture.recordToolStep({
			tool: "read_file",
			argsSummary: '{"path":"src/fetch.ts"}',
			ok: true,
			durationMs: 12,
		});
		capture.recordToolStep({
			tool: "edit_file",
			argsSummary: '{"path":"src/fetch.ts"}',
			ok: true,
			durationMs: 40,
		});
		const out = capture.finalizeTurn(TURN);

		expect(out).not.toBeNull();
		expect(out?.toolSteps.length).toBe(2);
		expect(out?.toolSteps[0].tool).toBe("read_file");
		expect(out?.allToolsSucceeded).toBe(true);

		const stored = capture.readTrajectories();
		expect(stored.length).toBe(1);
		expect(stored[0].sessionId).toBe("s1");
		expect(stored[0].toolSteps[1].durationMs).toBe(40);
	});

	test("clears the step buffer between turns", () => {
		const capture = new TraceCapture(freshRoot(), true);

		capture.recordToolStep({ tool: "run_command", argsSummary: '{"cmd":"ls"}', ok: true });
		const first = capture.finalizeTurn(TURN);
		const second = capture.finalizeTurn({ ...TURN, turnIndex: 2 });

		expect(first?.toolSteps.length).toBe(1);
		expect(second?.toolSteps.length).toBe(0);
	});
});

describe("TraceCapture PII scrubbing", () => {
	test("anonymizes PII before the trajectory hits disk", () => {
		const capture = new TraceCapture(freshRoot(), true);

		const out = capture.finalizeTurn({
			...TURN,
			prompt: "email the report to bob.smith@example.com when done",
		});

		expect(out).not.toBeNull();
		expect(out?.prompt).not.toContain("bob.smith@example.com");

		const stored = capture.readTrajectories();
		expect(JSON.stringify(stored)).not.toContain("bob.smith@example.com");
	});

	test("fails closed when a secret survives redaction", () => {
		const root = freshRoot();
		const capture = new TraceCapture(root, true);

		// redact() has no "password =" rule, so this survives redaction and
		// must trip containsSecret, dropping the whole trajectory.
		const out = capture.finalizeTurn({
			...TURN,
			response: "saved it: login password = hunter2supersecret",
		});

		expect(out).toBeNull();
		expect(existsSync(join(root, ".8gent", "kernel", "traces", "trajectories.jsonl"))).toBe(false);
	});

	test("fails closed when a tool step carries a surviving secret", () => {
		const capture = new TraceCapture(freshRoot(), true);

		capture.recordToolStep({
			tool: "run_command",
			argsSummary: '{"cmd":"export password = hunter2supersecret"}',
			ok: true,
		});
		const out = capture.finalizeTurn(TURN);

		expect(out).toBeNull();
		expect(capture.readTrajectories().length).toBe(0);
	});
});

describe("TraceCapture training pair adaptation", () => {
	function captured(overrides: Partial<Trajectory> = {}): Trajectory {
		return {
			sessionId: "s1",
			turnIndex: 1,
			model: "m",
			prompt: "p".repeat(60),
			response: "r".repeat(60),
			toolSteps: [{ tool: "edit_file", argsSummary: "{}", ok: true }],
			allToolsSucceeded: true,
			score: 0.85,
			capturedAt: 1_700_000_000_000,
			...overrides,
		};
	}

	test("adapts a fully successful trajectory into a TrainingPair", () => {
		const capture = new TraceCapture(freshRoot(), true);
		const pair = capture.toTrainingPair(captured(), "user-1");

		expect(pair).not.toBeNull();
		expect(pair?.userId).toBe("user-1");
		expect(pair?.toolCallsSucceeded).toBe(true);
		expect(pair?.score).toBe(0.85);
	});

	test("rejects a trajectory with a failed tool step", () => {
		const capture = new TraceCapture(freshRoot(), true);
		const pair = capture.toTrainingPair(
			captured({
				allToolsSucceeded: false,
				toolSteps: [{ tool: "run_command", argsSummary: "{}", ok: false }],
			}),
			"user-1",
		);

		expect(pair).toBeNull();
	});
});

describe("KernelManager trace capture wiring", () => {
	test("trace capture is OFF by default", () => {
		const manager = new KernelManager({ projectRoot: freshRoot() });
		expect(manager.isTraceCaptureEnabled).toBe(false);
	});

	test("fromProjectConfig opts in only on training_proxy.traceCapture: true", () => {
		const root = freshRoot();
		mkdirSync(join(root, ".8gent"), { recursive: true });
		writeFileSync(
			join(root, ".8gent", "config.json"),
			JSON.stringify({ training_proxy: { traceCapture: true } }),
		);

		expect(KernelManager.fromProjectConfig(root).isTraceCaptureEnabled).toBe(true);
		expect(KernelManager.fromProjectConfig(freshRoot()).isTraceCaptureEnabled).toBe(false);
	});

	test("collectSessionTrace persists the trajectory even before a userId is set", () => {
		const root = freshRoot();
		const manager = new KernelManager({ projectRoot: root, traceCapture: true });

		manager.recordToolStep({ tool: "edit_file", argsSummary: '{"path":"a.ts"}', ok: true });
		const collected = manager.collectSessionTrace("s9", TURN.prompt, TURN.response, 0.9, {
			model: "m",
			turnIndex: 3,
		});

		// No userId: the personal pair is not collected, but the session-scoped
		// trajectory is.
		expect(collected).toBe(false);
		const stored = manager.getTrajectories();
		expect(stored.length).toBe(1);
		expect(stored[0].turnIndex).toBe(3);
		expect(stored[0].toolSteps[0].tool).toBe("edit_file");
	});
});
