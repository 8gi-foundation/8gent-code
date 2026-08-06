import { describe, expect, it } from "bun:test";
import {
	type CandidateScore,
	SeleneJudge,
	SkyworkScorer,
	buildJudgePrompt,
	parseScore,
	parseVerdict,
	rankByScore,
} from "./local-judge";

describe("buildJudgePrompt", () => {
	it("embeds the rubric and output and asks for the strict verdict shape", () => {
		const prompt = buildJudgePrompt("const x = 1;", "Code must compile.");
		expect(prompt).toContain("Code must compile.");
		expect(prompt).toContain("const x = 1;");
		expect(prompt).toContain("VERDICT: PASS or VERDICT: FAIL");
		// No em dashes anywhere in generated text.
		expect(prompt).not.toContain("—");
	});

	it("clamps an oversized output so the judge prompt stays bounded", () => {
		const huge = "a".repeat(10_000);
		const prompt = buildJudgePrompt(huge, "rubric");
		// 6000-char output cap plus the fixed scaffold, never the full 10k.
		expect(prompt.length).toBeLessThan(10_000);
	});
});

describe("parseVerdict", () => {
	it("parses an explicit PASS verdict with its reason", () => {
		const v = parseVerdict("VERDICT: PASS\nREASON: The output meets every rubric item.");
		expect(v.pass).toBe(true);
		expect(v.source).toBe("selene");
		expect(v.rationale).toBe("The output meets every rubric item.");
	});

	it("parses an explicit FAIL verdict", () => {
		const v = parseVerdict("VERDICT: FAIL\nREASON: Missing error handling.");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("selene");
		expect(v.rationale).toBe("Missing error handling.");
	});

	it("is case-insensitive on the verdict token", () => {
		expect(parseVerdict("verdict: pass\nreason: ok").pass).toBe(true);
	});

	it("fails closed when the judge output has no verdict token", () => {
		const v = parseVerdict("This looks pretty good to me, nicely done.");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
	});

	it("does NOT infer PASS from approving prose (the MiniCPM false-approve trap)", () => {
		const v = parseVerdict("Yes this passes all tests and is excellent work, great job.");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
	});

	it("fails closed on empty judge output", () => {
		const v = parseVerdict("");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.raw).toBe("");
	});
});

describe("parseScore", () => {
	it("parses a bare numeric reward", () => {
		expect(parseScore("0.82")).toBe(0.82);
	});

	it("parses a JSON score field", () => {
		expect(parseScore('{"score": 0.5}')).toBe(0.5);
	});

	it("parses a JSON reward field", () => {
		expect(parseScore('{"reward": -1.25}')).toBe(-1.25);
	});

	it("parses a vLLM pooling data shape", () => {
		expect(parseScore('{"data":[{"data":[0.91]}]}')).toBe(0.91);
	});

	it("returns null when nothing numeric is present", () => {
		expect(parseScore("no number here")).toBeNull();
		expect(parseScore("")).toBeNull();
	});
});

describe("rankByScore", () => {
	it("ranks highest reward first", () => {
		const input: CandidateScore[] = [
			{ id: "a", score: 0.2 },
			{ id: "b", score: 0.9 },
			{ id: "c", score: 0.5 },
		];
		expect(rankByScore(input).map((c) => c.id)).toEqual(["b", "c", "a"]);
	});

	it("sorts null scores last so a silent reward model never wins", () => {
		const input: CandidateScore[] = [
			{ id: "a", score: null },
			{ id: "b", score: 0.1 },
		];
		expect(rankByScore(input).map((c) => c.id)).toEqual(["b", "a"]);
	});

	it("breaks ties deterministically by id", () => {
		const input: CandidateScore[] = [
			{ id: "z", score: 0.5 },
			{ id: "a", score: 0.5 },
		];
		expect(rankByScore(input).map((c) => c.id)).toEqual(["a", "z"]);
	});
});

describe("SeleneJudge fail-closed transport", () => {
	it("returns a fail-closed FAIL when the local judge is unreachable", async () => {
		// Unroutable port on localhost: connection refused, no network egress.
		const judge = new SeleneJudge({
			baseUrl: "http://127.0.0.1:1",
			model: "selene-mini",
			timeoutMs: 500,
		});
		const v = await judge.judge("some output", "some rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.rationale).toContain("unreachable");
	});

	it("reports unavailable when the Ollama server cannot be reached", async () => {
		const judge = new SeleneJudge({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
		expect(await judge.isAvailable()).toBe(false);
	});
});

describe("SkyworkScorer fail-closed transport", () => {
	it("scores an unreachable candidate as null (no network egress)", async () => {
		const scorer = new SkyworkScorer({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
		expect(await scorer.scoreOne("candidate text")).toBeNull();
	});

	it("ranks all candidates null and last-by-id when the endpoint is down", async () => {
		const scorer = new SkyworkScorer({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
		const ranked = await scorer.score([
			{ id: "z", output: "one" },
			{ id: "a", output: "two" },
		]);
		// Every score is null (endpoint down), so ties break deterministically by id.
		expect(ranked.every((c) => c.score === null)).toBe(true);
		expect(ranked.map((c) => c.id)).toEqual(["a", "z"]);
	});

	it("reports unavailable when the reward endpoint cannot be reached", async () => {
		const scorer = new SkyworkScorer({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
		expect(await scorer.isAvailable()).toBe(false);
	});
});
