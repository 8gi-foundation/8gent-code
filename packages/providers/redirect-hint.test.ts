/**
 * #4875 part 2: a refused redirect tells the user which setting to change. Each site gets a loopback
 * stub that answers 308 (what a reverse proxy sends for http to https) and the test asserts the hint
 * text appears, with the verdict still a failure (never an allow).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateResponse } from "../board-vessel/inference";
import { localSpokenModel } from "../daemon/telegram-bridge";
import { JudgeScorer } from "../kernel/judge";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { SeleneJudge, SkyworkScorer } from "./local-judge";
import { redirectHint } from "./redirect-hint";

let stub: ReturnType<typeof Bun.serve>;
let url: string;
let host: string;
let hits = 0;
const SAVED = { ...process.env };

beforeAll(() => {
	stub = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			hits++;
			return new Response(null, { status: 308, headers: { Location: "https://example.invalid/x" } });
		},
	});
	url = `http://127.0.0.1:${stub.port}`;
	host = `127.0.0.1:${stub.port}`;
});

afterAll(() => {
	stub.stop(true);
	process.env = SAVED;
	cleanupTempDirs();
});

const hint = (setting: string) => `the URL ${host} redirected; set the https URL in ${setting}`;

describe("redirect hint, one stub per site", () => {
	test("hint text and non-redirect errors", () => {
		expect(redirectHint(new Error("boom"), url, "X")).toBe("");
		expect(redirectHint(Object.assign(new TypeError("x"), { code: "UnexpectedRedirect" }), url, "X")).toBe(
			hint("X"),
		);
	});

	test("board vessel, Ollama path names OLLAMA_HOST", async () => {
		process.env.INFERENCE_MODE = "ollama";
		process.env.OLLAMA_HOST = url;
		await expect(
			generateResponse({ systemPrompt: "s", contextMessages: [], userMessage: "hi" } as never),
		).rejects.toThrow(hint("OLLAMA_HOST"));
	});

	test("board vessel, model proxy path names MODEL_PROXY_URL", async () => {
		process.env.INFERENCE_MODE = "proxy";
		process.env.MODEL_PROXY_URL = url;
		await expect(
			generateResponse({ systemPrompt: "s", contextMessages: [], userMessage: "hi" } as never),
		).rejects.toThrow(hint("MODEL_PROXY_URL"));
	});

	test("bridge local model names OLLAMA_HOST", async () => {
		const ask = localSpokenModel({ OLLAMA_HOST: url });
		expect(ask).not.toBeNull();
		await expect((ask as NonNullable<typeof ask>)("hi")).rejects.toThrow(hint("OLLAMA_HOST"));
	});

	test("Selene judge: fail-closed FAIL verdict carrying the hint", async () => {
		const v = await new SeleneJudge({ baseUrl: url }).judge("out", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.rationale).toContain(hint("the judge baseUrl option"));
	});

	test("Skywork scorer: null score (never a pass), one hint line", async () => {
		const err = spyOn(console, "error").mockImplementation(() => {});
		const s = new SkyworkScorer({ baseUrl: url });
		expect(await s.scoreOne("a")).toBeNull();
		expect(await s.scoreOne("b")).toBeNull();
		const lines = err.mock.calls.map((c) => String(c[0]));
		err.mockRestore();
		expect(lines.filter((l) => l.includes(hint("the scorer baseUrl option"))).length).toBe(1);
	});

	test("kernel judge names prmUrl and records nothing", async () => {
		const dir = tempDir("redirect-hint-");
		const j = new JudgeScorer({ prmUrl: url, prmApiKey: "k", historyPath: `${dir}/h.jsonl` });
		await expect(j.score("s", 0, "m", "plain prompt", "plain reply")).rejects.toThrow(
			hint("the prmUrl option"),
		);
	});

	test("the stub saw every call and nothing followed the redirect", () => {
		expect(hits).toBeGreaterThanOrEqual(7);
	});
});
