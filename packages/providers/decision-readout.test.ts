import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	DECISION_QUESTION_ID,
	DecisionReadoutJudge,
	buildDecisionRequest,
	decisionConfigFromEnv,
	decisionJudgeEnabled,
	isLoopbackUrl,
	parseDecisionProbability,
} from "./decision-readout";
import { SeleneJudge } from "./local-judge";

// Fake llama-server /v1/systemone and fake Ollama /api/generate, loopback only.
// The response is chosen per test through `reply`; requests are recorded.
type Reply = { status?: number; body: string; delayMs?: number };
let reply: Reply = { body: "{}" };
const hits: { path: string; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

function noul(p: unknown): string {
	return JSON.stringify({
		model: "fake",
		answers: { [DECISION_QUESTION_ID]: { type: "noul", noul: p } },
		usage: { input_tokens: 10, output_tokens: 0 },
	});
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			hits.push({ path, body: await req.json().catch(() => null) });
			if (reply.delayMs) await Bun.sleep(reply.delayMs);
			return new Response(reply.body, {
				status: reply.status ?? 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

const savedEnv = {
	flag: process.env.EIGHT_DECISION_JUDGE,
	url: process.env.EIGHT_DECISION_JUDGE_URL,
	threshold: process.env.EIGHT_DECISION_JUDGE_THRESHOLD,
};
afterEach(() => {
	hits.length = 0;
	reply = { body: "{}" };
	for (const [k, v] of [
		["EIGHT_DECISION_JUDGE", savedEnv.flag],
		["EIGHT_DECISION_JUDGE_URL", savedEnv.url],
		["EIGHT_DECISION_JUDGE_THRESHOLD", savedEnv.threshold],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("buildDecisionRequest", () => {
	it("sends one noul question with the rubric and output in state (PR 29818 shape)", () => {
		const body = buildDecisionRequest("const x = 1;", "Code must compile.") as {
			state: string;
			questions: Record<
				string,
				{ type: string; instructions: string; criteria: Record<string, string> }
			>;
		};
		expect(body.state).toContain("Code must compile.");
		expect(body.state).toContain("const x = 1;");
		const q = body.questions[DECISION_QUESTION_ID];
		expect(q.type).toBe("noul");
		expect(typeof q.instructions).toBe("string");
		expect(Object.keys(q.criteria).sort()).toEqual(["false", "true"]);
		expect(JSON.stringify(body)).not.toContain("\u2014");
	});

	it("clamps an oversized output", () => {
		const body = buildDecisionRequest("a".repeat(10_000), "r") as { state: string };
		expect(body.state.length).toBeLessThan(10_000);
	});
});

describe("parseDecisionProbability", () => {
	it("reads answers.pass.noul", () => {
		expect(parseDecisionProbability(noul(0.73))).toBe(0.73);
	});
	it.each([
		["malformed JSON", "{not json"],
		["empty body", ""],
		["no answers", JSON.stringify({ model: "x" })],
		["wrong type", JSON.stringify({ answers: { pass: { type: "score", noul: 0.95 } } })],
		["string probability", noul("0.95")],
		["NaN probability", '{"answers":{"pass":{"type":"noul","noul":NaN}}}'],
		["null probability", noul(null)],
		["probability above 1", noul(1.5)],
		["probability below 0", noul(-0.1)],
	])("returns null for %s", (_label, raw) => {
		expect(parseDecisionProbability(raw)).toBeNull();
	});
});

describe("isLoopbackUrl", () => {
	it.each([
		"http://127.0.0.1:8080",
		"http://localhost:8080",
		"http://[::1]:8080",
		"http://127.1.2.3",
	])("accepts %s", (u) => expect(isLoopbackUrl(u)).toBe(true));
	it.each([
		"http://10.0.0.5:8080",
		"http://192.168.1.2:8080",
		"https://example.com",
		"http://127.0.0.1.evil.com",
		"http://user:pw@127.0.0.1:8080",
		"file:///etc/passwd",
		"not a url",
	])("refuses %s", (u) => expect(isLoopbackUrl(u)).toBe(false));
});

describe("DecisionReadoutJudge against a fake 127.0.0.1 server", () => {
	it("passes when P(yes) is at or above the threshold", async () => {
		reply = { body: noul(0.95) };
		const v = await new DecisionReadoutJudge({ baseUrl: base, threshold: 0.9 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(true);
		expect(v.source).toBe("decision-readout");
		expect(hits).toHaveLength(1);
		expect(hits[0].path).toBe("/v1/systemone");
		expect((hits[0].body as { questions: Record<string, unknown> }).questions).toHaveProperty(
			DECISION_QUESTION_ID,
		);
	});

	it("passes exactly at the threshold", async () => {
		reply = { body: noul(0.9) };
		const v = await new DecisionReadoutJudge({ baseUrl: base, threshold: 0.9 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(true);
	});

	it("fails when P(yes) is below the threshold", async () => {
		reply = { body: noul(0.89) };
		const v = await new DecisionReadoutJudge({ baseUrl: base, threshold: 0.9 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(false);
		expect(v.source).toBe("decision-readout");
		expect(v.rationale).toContain("<");
	});

	it("ignores a threshold of 0 and uses the 0.9 default", async () => {
		reply = { body: noul(0.5) };
		const v = await new DecisionReadoutJudge({ baseUrl: base, threshold: 0 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(false);
	});

	it.each([
		["malformed JSON", "{not json"],
		["NaN", '{"answers":{"pass":{"type":"noul","noul":NaN}}}'],
		["above 1", noul(1.2)],
		["below 0", noul(-0.5)],
	])("fails closed on %s", async (_label, body) => {
		reply = { body };
		const v = await new DecisionReadoutJudge({ baseUrl: base }).judge("out", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
	});

	it("fails closed on an HTTP error such as 501 (not a decision model)", async () => {
		reply = { status: 501, body: '{"error":"not a decision model"}' };
		const v = await new DecisionReadoutJudge({ baseUrl: base }).judge("out", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
	});

	it("fails closed on a response larger than the cap", async () => {
		reply = { body: noul(0.99) + " ".repeat(2048) };
		const v = await new DecisionReadoutJudge({ baseUrl: base, maxResponseBytes: 1024 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(false);
		expect(v.rationale).toContain("exceeded");
	});

	it("fails closed on timeout", async () => {
		reply = { body: noul(0.99), delayMs: 1500 };
		const started = Date.now();
		const v = await new DecisionReadoutJudge({ baseUrl: base, timeoutMs: 200 }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(Date.now() - started).toBeLessThan(1400);
	});

	it("fails closed when the server is unreachable", async () => {
		const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const port = dead.port;
		dead.stop(true);
		const v = await new DecisionReadoutJudge({
			baseUrl: `http://127.0.0.1:${port}`,
			timeoutMs: 2000,
		}).judge("out", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.rationale).toContain("unreachable");
	});

	it("refuses a non-loopback URL without sending a request", async () => {
		const v = await new DecisionReadoutJudge({ baseUrl: "http://10.255.255.1:8080" }).judge(
			"out",
			"rubric",
		);
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.rationale).toContain("not a loopback URL");
		expect(hits).toHaveLength(0);
	});
});

describe("EIGHT_DECISION_JUDGE flag in SeleneJudge", () => {
	it("is off unless the flag is exactly 1", () => {
		expect(decisionJudgeEnabled({})).toBe(false);
		expect(decisionJudgeEnabled({ EIGHT_DECISION_JUDGE: "true" })).toBe(false);
		expect(decisionJudgeEnabled({ EIGHT_DECISION_JUDGE: "1" })).toBe(true);
	});

	it("reads URL and threshold from env", () => {
		expect(
			decisionConfigFromEnv({
				EIGHT_DECISION_JUDGE_URL: "http://127.0.0.1:9",
				EIGHT_DECISION_JUDGE_THRESHOLD: "0.8",
			}),
		).toEqual({ baseUrl: "http://127.0.0.1:9", threshold: 0.8 });
	});

	it("flag off: SeleneJudge still posts to /api/generate and parses prose", async () => {
		delete process.env.EIGHT_DECISION_JUDGE;
		reply = { body: JSON.stringify({ response: "VERDICT: PASS\nREASON: ok." }) };
		const v = await new SeleneJudge({ baseUrl: base }).judge("out", "rubric");
		expect(v.pass).toBe(true);
		expect(v.source).toBe("selene");
		expect(hits.map((h) => h.path)).toEqual(["/api/generate"]);
	});

	it("flag on: SeleneJudge routes to /v1/systemone", async () => {
		process.env.EIGHT_DECISION_JUDGE = "1";
		process.env.EIGHT_DECISION_JUDGE_URL = base;
		reply = { body: noul(0.97) };
		const v = await new SeleneJudge({ baseUrl: "http://127.0.0.1:1" }).judge("out", "rubric");
		expect(v.pass).toBe(true);
		expect(v.source).toBe("decision-readout");
		expect(hits.map((h) => h.path)).toEqual(["/v1/systemone"]);
	});

	it("flag on with a non-loopback URL in env fails closed", async () => {
		process.env.EIGHT_DECISION_JUDGE = "1";
		process.env.EIGHT_DECISION_JUDGE_URL = "https://example.com";
		const v = await new SeleneJudge({ baseUrl: base }).judge("out", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(hits).toHaveLength(0);
	});
});
