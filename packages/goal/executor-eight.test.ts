/**
 * EightExecutor unit tests.
 *
 * The real Agent class is heavy (constructs SessionWriter, HookManager, the
 * tool registry, etc.). We don't want to drag any of that into the test
 * sandbox - those are exercised in `packages/eight/__tests__/`. Here we
 * inject an `agentFactory` stub that gives us a minimal AgentLike so we can
 * assert the executor's contract: shape of the returned ExecutorTurnOutput,
 * accumulation of usage events, abort semantics.
 */

import { describe, expect, it } from "bun:test";
import { EightExecutor, type AgentLike } from "./executor-eight";
import type { AgentEventCallbacks, AgentStepEvent } from "../eight/types";
import type { ExecutorTurnInput } from "./types";

interface StubBehaviour {
	finalText?: string;
	steps?: Array<Pick<AgentStepEvent, "stepNumber" | "finishReason" | "text" | "usage"> & {
		toolCalls?: Array<{ toolName: string; toolCallId: string }>;
	}>;
	toolEnds?: Array<{
		toolName: string;
		toolCallId: string;
		args: Record<string, unknown>;
		success: boolean;
		durationMs: number;
	}>;
	throws?: Error;
	delayMs?: number;
}

function stubFactory(b: StubBehaviour, capture?: { config?: unknown; cleanedUp?: boolean }) {
	return async (config: import("../eight/types").AgentConfig): Promise<AgentLike> => {
		if (capture) capture.config = config;
		const events: AgentEventCallbacks | undefined = config.events;
		return {
			async chat(_prompt: string): Promise<string> {
				if (b.throws) throw b.throws;
				for (const step of b.steps ?? []) {
					events?.onStepFinish?.({
						stepNumber: step.stepNumber,
						finishReason: step.finishReason,
						text: step.text,
						toolCalls: step.toolCalls ?? [],
						usage: step.usage,
					});
				}
				for (const t of b.toolEnds ?? []) {
					events?.onToolEnd?.({ ...t });
				}
				if (b.delayMs) {
					await new Promise((r) => setTimeout(r, b.delayMs));
				}
				return b.finalText ?? "";
			},
			async cleanup() {
				if (capture) capture.cleanedUp = true;
			},
		};
	};
}

describe("EightExecutor", () => {
	it("requires model and runtime", () => {
		expect(() => new EightExecutor({ model: "", runtime: "ollama" })).toThrow();
		expect(
			() =>
				new EightExecutor({
					model: "x",
					runtime: undefined as unknown as "ollama",
				}),
		).toThrow();
	});

	it("returns ExecutorTurnOutput with summed usage from step events", async () => {
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({
				finalText: "All done. Implementation complete.",
				steps: [
					{
						stepNumber: 1,
						finishReason: "tool-calls",
						text: "",
						usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
					},
					{
						stepNumber: 2,
						finishReason: "stop",
						text: "wrap-up step text",
						usage: { promptTokens: 30, completionTokens: 25, totalTokens: 55 },
					},
				],
			}),
		});

		const input: ExecutorTurnInput = { goal: "make x", turn: 1 };
		const out = await exec.turn(input);
		expect(out.tokensIn).toBe(130);
		expect(out.tokensOut).toBe(75);
		expect(out.summary).toBe("All done. Implementation complete.");
	});

	it("counts touched files from onToolEnd write events", async () => {
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({
				finalText: "wrote two files",
				steps: [],
				toolEnds: [
					{
						toolName: "Write",
						toolCallId: "t1",
						args: { file_path: "/tmp/a.txt" },
						success: true,
						durationMs: 1,
					},
					{
						toolName: "Edit",
						toolCallId: "t2",
						args: { file_path: "/tmp/b.txt" },
						success: true,
						durationMs: 1,
					},
					{
						toolName: "Read",
						toolCallId: "t3",
						args: { file_path: "/tmp/c.txt" },
						success: true,
						durationMs: 1,
					},
				],
			}),
		});
		const out = await exec.turn({ goal: "files", turn: 1 });
		expect(out.filesChanged).toBe(2); // Write + Edit, Read ignored
	});

	it("prompt contains goal, subgoal, and prior verdict guidance", async () => {
		let capturedPrompt = "";
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: async () => ({
				async chat(prompt: string): Promise<string> {
					capturedPrompt = prompt;
					return "ok";
				},
				async cleanup() {},
			}),
		});

		await exec.turn({
			goal: "ship feature X",
			turn: 2,
			subgoal: "first fix the lint",
			priorVerdict: {
				decision: "continue",
				confidence: 0.4,
				summary: "tests not yet passing",
				nextStep: "run vitest",
			},
		});

		expect(capturedPrompt).toContain("GOAL (turn 2)");
		expect(capturedPrompt).toContain("ship feature X");
		expect(capturedPrompt).toContain("SUBGOAL");
		expect(capturedPrompt).toContain("first fix the lint");
		expect(capturedPrompt).toContain("JUDGE VERDICT FROM PREVIOUS TURN");
		expect(capturedPrompt).toContain("tests not yet passing");
		expect(capturedPrompt).toContain("run vitest");
	});

	it("strips em dashes from summary", async () => {
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({ finalText: "done — fully shipped" }),
		});
		const out = await exec.turn({ goal: "x", turn: 1 });
		expect(out.summary).toBe("done - fully shipped");
		expect(out.summary).not.toContain("—");
	});

	it("propagates agent errors out of .turn()", async () => {
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({ throws: new Error("agent crashed") }),
		});
		await expect(exec.turn({ goal: "x", turn: 1 })).rejects.toThrow("agent crashed");
	});

	it("calls cleanup() after each turn", async () => {
		const capture: { cleanedUp?: boolean } = {};
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({ finalText: "x" }, capture),
		});
		await exec.turn({ goal: "x", turn: 1 });
		expect(capture.cleanedUp).toBe(true);
	});

	it("abort flag rejects subsequent turn() calls", async () => {
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "ollama",
			agentFactory: stubFactory({ finalText: "x" }),
		});
		exec.abort();
		await expect(exec.turn({ goal: "x", turn: 1 })).rejects.toThrow(/aborted/);
	});

	it("forwards working directory and channel to AgentConfig", async () => {
		const capture: { config?: unknown } = {};
		const exec = new EightExecutor({
			model: "test-model",
			runtime: "apfel",
			workingDirectory: "/tmp/work",
			channel: "computer",
			maxStepsPerTurn: 5,
			agentFactory: stubFactory({ finalText: "x" }, capture),
		});
		await exec.turn({ goal: "x", turn: 1 });
		const cfg = capture.config as import("../eight/types").AgentConfig;
		expect(cfg.workingDirectory).toBe("/tmp/work");
		expect(cfg.channel).toBe("computer");
		expect(cfg.maxTurns).toBe(5);
		expect(cfg.runtime).toBe("apfel");
		expect(cfg.model).toBe("test-model");
	});
});
