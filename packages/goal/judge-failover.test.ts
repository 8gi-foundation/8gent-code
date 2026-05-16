/**
 * FailoverJudge unit tests.
 *
 * Mocks the failover chain + client factory. Doesn't hit real models. A
 * separate "smoke" suite at the bottom runs against a real local model if
 * one is reachable; otherwise skips.
 */

import { describe, expect, it } from "bun:test";
import {
	FailoverJudge,
	parseJudgeJson,
} from "./judge-failover";
import { JudgeExecutorCollisionError } from "./judge";
import { ModelFailover } from "../providers/failover";
import type { LLMClient, LLMResponse, Message } from "../eight/types";
import type { JudgeHandleInput } from "./types";

class StubClient implements LLMClient {
	calls = 0;
	generateResponses: string[] = [];
	chatResponses: string[] = [];
	throwGenerate?: Error;
	throwChat?: Error;
	delayMs?: number;

	async chat(_messages: Message[]): Promise<LLMResponse> {
		this.calls += 1;
		if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.throwChat) throw this.throwChat;
		const text = this.chatResponses.shift() ?? "";
		return {
			model: "stub",
			message: { role: "assistant", content: text },
			done: true,
		};
	}
	async generate(_prompt: string): Promise<string> {
		this.calls += 1;
		if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.throwGenerate) throw this.throwGenerate;
		return this.generateResponses.shift() ?? "";
	}
	async isAvailable(): Promise<boolean> {
		return true;
	}
}

function makeInput(over: Partial<JudgeHandleInput> = {}): JudgeHandleInput {
	return {
		goal: over.goal ?? "create file at /tmp/x",
		turn: over.turn ?? 1,
		executorOutput: over.executorOutput ?? {
			summary: "wrote /tmp/x",
			tokensIn: 10,
			tokensOut: 5,
		},
		history: over.history ?? [],
	};
}

describe("FailoverJudge - construction", () => {
	it("rejects when judge model equals executor model (anti-collusion)", () => {
		expect(
			() =>
				new FailoverJudge({
					executorModel: "qwen3:14b",
					judgeModel: "qwen3:14b",
				}),
		).toThrow(JudgeExecutorCollisionError);
	});

	it("rejects when judge model equals executor model after normalization", () => {
		expect(
			() =>
				new FailoverJudge({
					executorModel: "QWEN3:14B",
					judgeModel: "qwen3:14b",
				}),
		).toThrow(JudgeExecutorCollisionError);
	});

	it("accepts when models differ", () => {
		const j = new FailoverJudge({
			executorModel: "qwen3:14b",
			judgeModel: "apple-foundationmodel",
		});
		expect(j.model).toBe("apple-foundationmodel");
	});
});

describe("FailoverJudge - happy path", () => {
	it("returns satisfied + confidence + reason from valid JSON response", async () => {
		const client = new StubClient();
		// First call is criterion extraction, second is the judge call.
		client.generateResponses = [
			"A file exists at /tmp/x.",
			JSON.stringify({ done: true, confidence: 0.92, reason: "file exists" }),
		];
		const j = new FailoverJudge({
			executorModel: "qwen3:14b",
			judgeModel: "apple-foundationmodel",
			clientFactory: () => client,
		});
		const verdict = await j.score(makeInput());
		expect(verdict.decision).toBe("satisfied");
		expect(verdict.confidence).toBe(0.92);
		expect(verdict.summary).toBe("file exists");
	});

	it("maps done:false to continue", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"A file exists at /tmp/x.",
			JSON.stringify({ done: false, confidence: 0.3, reason: "not yet" }),
		];
		const j = new FailoverJudge({
			executorModel: "qwen3:14b",
			judgeModel: "apple-foundationmodel",
			clientFactory: () => client,
		});
		const verdict = await j.score(makeInput());
		expect(verdict.decision).toBe("continue");
		expect(verdict.confidence).toBe(0.3);
	});

	it("tolerates code-fenced JSON output", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"crit",
			"```json\n{\"done\": true, \"confidence\": 0.8, \"reason\": \"ok\"}\n```",
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		const v = await j.score(makeInput());
		expect(v.decision).toBe("satisfied");
		expect(v.confidence).toBe(0.8);
	});

	it("tolerates JSON wrapped in prose", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"crit",
			"Sure! Here is my verdict: {\"done\":true,\"confidence\":0.9,\"reason\":\"done\"} - hope that helps.",
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		const v = await j.score(makeInput());
		expect(v.decision).toBe("satisfied");
	});

	it("caches the extracted criterion across calls (one extraction per goal)", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"criterion text",
			JSON.stringify({ done: false, confidence: 0.5, reason: "ongoing" }),
			JSON.stringify({ done: true, confidence: 0.9, reason: "done now" }),
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		await j.score(makeInput({ turn: 1 }));
		await j.score(makeInput({ turn: 2 }));
		// 1 criterion extraction + 2 judge calls = 3 total
		expect(client.calls).toBe(3);
	});
});

describe("FailoverJudge - fail open", () => {
	it("returns continue + 0 confidence when judge throws", async () => {
		const client = new StubClient();
		client.generateResponses = ["crit"];
		client.throwGenerate = new Error("network unreachable");
		client.throwChat = new Error("network unreachable");
		// Override after the criterion call by burning the queued criterion
		// response - but the criterion path uses the SAME client and the
		// SAME throws. To avoid criterion failing too, give it a non-throw
		// path via a separate stub.
		let call = 0;
		const factoryClient = new StubClient();
		factoryClient.generateResponses = ["a criterion"];
		const judgeOnlyFail = new StubClient();
		judgeOnlyFail.throwGenerate = new Error("network unreachable");
		judgeOnlyFail.throwChat = new Error("network unreachable");

		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => {
				const c = call === 0 ? factoryClient : judgeOnlyFail;
				call += 1;
				return c;
			},
		});
		const verdict = await j.score(makeInput());
		expect(verdict.decision).toBe("continue");
		expect(verdict.confidence).toBe(0);
		expect(verdict.summary).toMatch(/judge unavailable/);
	});

	it("returns continue + 0 confidence when JSON is malformed", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"criterion",
			"this is not json at all, just prose",
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		const v = await j.score(makeInput());
		expect(v.decision).toBe("continue");
		expect(v.confidence).toBe(0);
		expect(v.summary).toMatch(/judge unavailable/);
	});

	it("returns continue + 0 confidence when confidence is out of range", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"criterion",
			JSON.stringify({ done: true, confidence: 1.5, reason: "ok" }),
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		const v = await j.score(makeInput());
		expect(v.decision).toBe("continue");
		expect(v.confidence).toBe(0);
	});

	it("falls back to raw goal as criterion when extraction throws", async () => {
		const factoryCalls: Array<{ runtime: string; model: string }> = [];
		const client = new StubClient();
		// First .generate() (criterion) throws AND .chat() also throws.
		client.throwGenerate = new Error("extraction failed");
		client.throwChat = new Error("extraction failed");

		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: (cfg) => {
				factoryCalls.push(cfg);
				return client;
			},
		});
		// Score will fall back to raw goal for criterion, then judge call
		// also throws, so we get a fail-open verdict. The important thing
		// is we don't blow up.
		const v = await j.score(makeInput());
		expect(v.decision).toBe("continue");
		expect(v.confidence).toBe(0);
	});

	it("times out long-running judge calls and fails open", async () => {
		const client = new StubClient();
		client.generateResponses = ["crit"];
		const slowClient = new StubClient();
		slowClient.delayMs = 200;
		slowClient.generateResponses = ["whatever"];
		let call = 0;
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			timeoutMs: 50,
			clientFactory: () => {
				const c = call === 0 ? client : slowClient;
				call += 1;
				return c;
			},
		});
		const v = await j.score(makeInput());
		expect(v.decision).toBe("continue");
		expect(v.confidence).toBe(0);
		expect(v.summary).toMatch(/judge unavailable/);
	});

	it("routes lmstudio provider to lmstudio runtime (regression: previously fell through to openrouter)", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"crit",
			JSON.stringify({ done: false, confidence: 0.1, reason: "still working" }),
		];
		const factoryCalls: Array<{ runtime: string; model: string }> = [];
		const failover = new ModelFailover({
			text: {
				"lmstudio-judge": {
					models: [{ model: "lmstudio-judge", provider: "lmstudio" }],
				},
			},
			computer: {},
		});
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "lmstudio-judge",
			failover,
			clientFactory: (cfg) => {
				factoryCalls.push(cfg);
				return client;
			},
		});
		await j.score(makeInput());
		expect(factoryCalls.length).toBeGreaterThan(0);
		expect(factoryCalls[0]?.runtime).toBe("lmstudio");
	});

	it("never returns a summary with em dashes", async () => {
		const client = new StubClient();
		client.generateResponses = [
			"crit",
			JSON.stringify({
				done: false,
				confidence: 0.2,
				reason: "still working — give it time",
			}),
		];
		const j = new FailoverJudge({
			executorModel: "exec",
			judgeModel: "judge",
			clientFactory: () => client,
		});
		const v = await j.score(makeInput());
		expect(v.summary).not.toContain("—");
	});
});

describe("parseJudgeJson", () => {
	it("parses bare JSON", () => {
		const r = parseJudgeJson('{"done": true, "confidence": 0.8, "reason": "x"}');
		expect(r).toEqual({ done: true, confidence: 0.8, reason: "x" });
	});

	it("parses code-fenced JSON", () => {
		const r = parseJudgeJson('```json\n{"done":false,"confidence":0.1,"reason":"y"}\n```');
		expect(r.done).toBe(false);
		expect(r.confidence).toBe(0.1);
	});

	it("throws on empty input", () => {
		expect(() => parseJudgeJson("")).toThrow();
	});

	it("throws on missing fields", () => {
		expect(() => parseJudgeJson('{"done":true}')).toThrow();
	});

	it("throws when done is not boolean", () => {
		expect(() => parseJudgeJson('{"done":"yes","confidence":0.5,"reason":"x"}')).toThrow();
	});

	it("throws when confidence out of range", () => {
		expect(() => parseJudgeJson('{"done":true,"confidence":2,"reason":"x"}')).toThrow();
	});

	it("supplies default reason if missing", () => {
		const r = parseJudgeJson('{"done":true,"confidence":0.9}');
		expect(r.reason).toBe("no reason provided");
	});
});

// ---- Smoke test against a real local model (skipped by default) -----------
//
// Gated behind `GOAL_SMOKE=1` because a real judge call against a 14B+ model
// can take 30-90s and we don't want CI / pre-commit pulled into that. Run
// the smoke locally with: `GOAL_SMOKE=1 bun test packages/goal/judge-failover.test.ts`.

async function hasLocalModel(): Promise<boolean> {
	if (process.env.GOAL_SMOKE !== "1") return false;
	try {
		const res = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(500),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { models?: unknown[] };
		return Array.isArray(body.models) && body.models.length > 0;
	} catch {
		return false;
	}
}

const localAvailable = await hasLocalModel();

describe.skipIf(!localAvailable)("FailoverJudge - real local model smoke", () => {
	it("returns valid verdict shape for a trivial goal", async () => {
		// Pick the first ollama model as judge. Force executor to a different
		// id so the anti-collusion check passes regardless of which model is
		// actually loaded.
		const tagsRes = await fetch("http://localhost:11434/api/tags");
		const body = (await tagsRes.json()) as { models: Array<{ name: string }> };
		const judgeModel = body.models[0]?.name;
		if (!judgeModel) throw new Error("no local models");

		const failover = new ModelFailover({
			text: {
				[judgeModel]: {
					models: [{ model: judgeModel, provider: "ollama" }],
				},
			},
			computer: {},
		});

		const j = new FailoverJudge({
			executorModel: `${judgeModel}-not-this`,
			judgeModel,
			failover,
			timeoutMs: 60_000,
		});

		const v = await j.score(
			makeInput({
				goal: "criterion: file at /tmp/x exists",
				executorOutput: {
					summary: "Created /tmp/x via touch. File now exists at that path.",
					tokensIn: 100,
					tokensOut: 50,
				},
			}),
		);
		// Don't assert on decision (local model may be too small to judge
		// correctly). Just assert shape contract is honoured.
		expect(["satisfied", "continue", "failed"]).toContain(v.decision);
		expect(typeof v.confidence).toBe("number");
		expect(v.confidence).toBeGreaterThanOrEqual(0);
		expect(v.confidence).toBeLessThanOrEqual(1);
		expect(typeof v.summary).toBe("string");
		expect(v.summary.length).toBeGreaterThan(0);
		expect(v.summary).not.toContain("—");
	}, 90_000);
});
