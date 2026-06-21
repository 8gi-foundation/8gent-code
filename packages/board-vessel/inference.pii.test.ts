/**
 * PII gate tests for the officer-chat brain (board-vessel inference).
 *
 * `generateResponse()` sends the full systemPrompt + contextMessages +
 * userMessage to the model proxy, an `*.internal` host that forwards to a public
 * cloud provider. This was the leak that exposed James's identity in every
 * officer chat. These tests assert the outbound proxy payload is anonymized,
 * the reply is de-anonymized, the local Ollama path is untouched, and a cloud
 * target fails closed when anonymization cannot run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateResponse } from "./inference";

const PII_SYSTEM =
	"You are 8EO. The owner is James Spalding (jamesspaldingles@gmail.com).";
const PII_USER = "Email Sarah Connor at sarah.connor@example.com about the +1 (415) 555-0182 line.";

const LEAKS = [
	"James Spalding",
	"jamesspaldingles@gmail.com",
	"Sarah Connor",
	"sarah.connor@example.com",
	"555-0182",
];

const realFetch = globalThis.fetch;
let lastBody: any = null;
let lastUrl = "";

const savedEnv = {
	INFERENCE_MODE: process.env.INFERENCE_MODE,
	MODEL_PROXY_URL: process.env.MODEL_PROXY_URL,
	OLLAMA_HOST: process.env.OLLAMA_HOST,
};

beforeEach(() => {
	lastBody = null;
	lastUrl = "";
});

afterEach(() => {
	globalThis.fetch = realFetch;
	process.env.INFERENCE_MODE = savedEnv.INFERENCE_MODE;
	process.env.MODEL_PROXY_URL = savedEnv.MODEL_PROXY_URL;
	process.env.OLLAMA_HOST = savedEnv.OLLAMA_HOST;
});

/** Stub fetch capturing the outbound body + url, returning a canned reply. */
function stubProxy(replyContent: string): void {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		lastUrl = String(url);
		lastBody = init?.body ? JSON.parse(init.body as string) : null;
		return new Response(
			JSON.stringify({
				choices: [{ message: { role: "assistant", content: replyContent } }],
				usage: { completion_tokens: 5 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
}

describe("board inference PII gate (GAP 2)", () => {
	test("cloud proxy (*.internal): no PII appears in the outbound payload", async () => {
		process.env.INFERENCE_MODE = "proxy";
		process.env.MODEL_PROXY_URL = "http://8gi-model-proxy.internal:3200";
		stubProxy("Acknowledged.");

		await generateResponse({
			systemPrompt: PII_SYSTEM,
			contextMessages: [{ role: "assistant", content: "Hi James Spalding." }],
			userMessage: PII_USER,
		});

		const sent = JSON.stringify(lastBody);
		for (const leak of LEAKS) expect(sent).not.toContain(leak);
		// Pseudonyms WERE sent (the turn was not dropped).
		expect(sent).toContain("[PERSON_");
		expect(sent).toContain("[EMAIL_");
	});

	test("de-anonymizes the reply so the officer sees the real value", async () => {
		process.env.INFERENCE_MODE = "proxy";
		process.env.MODEL_PROXY_URL = "http://8gi-model-proxy.internal:3200";
		// The cloud will echo whatever pseudonym it was given for the owner email.
		// Send a payload, capture the token, then craft a reply that echoes it.
		stubProxy("placeholder");
		await generateResponse({
			systemPrompt: PII_SYSTEM,
			contextMessages: [],
			userMessage: "noop",
		});
		const sent = JSON.stringify(lastBody);
		const tokenMatch = sent.match(/\[EMAIL_\d+\]/);
		expect(tokenMatch).not.toBeNull();
		const token = tokenMatch![0];

		stubProxy(`I will email ${token} right away.`);
		const res = await generateResponse({
			systemPrompt: PII_SYSTEM,
			contextMessages: [],
			userMessage: "send it",
		});
		expect(res.response).toContain("jamesspaldingles@gmail.com");
		expect(res.response).not.toContain(token);
	});

	test("local ollama path is NOT gated (data stays on-device)", async () => {
		process.env.INFERENCE_MODE = "ollama";
		process.env.OLLAMA_HOST = "http://localhost:11434";
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			lastUrl = String(url);
			lastBody = init?.body ? JSON.parse(init.body as string) : null;
			return new Response(
				JSON.stringify({ message: { content: "ok" }, eval_count: 3 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		await generateResponse({
			systemPrompt: PII_SYSTEM,
			contextMessages: [],
			userMessage: PII_USER,
		});

		const sent = JSON.stringify(lastBody);
		// Local: the model sees the REAL values, nothing masked.
		expect(sent).toContain("James Spalding");
		expect(sent).toContain("jamesspaldingles@gmail.com");
		expect(sent).not.toContain("[PERSON_");
	});

	test("fail-closed: cloud target refuses when anonymization cannot run", async () => {
		process.env.INFERENCE_MODE = "proxy";
		process.env.MODEL_PROXY_URL = "http://8gi-model-proxy.internal:3200";
		globalThis.fetch = (async () => {
			throw new Error("LEAK: network reached on a refused request");
		}) as unknown as typeof fetch;

		// A context message whose content getter throws makes anonymizeMessages
		// raise; the cloud target must refuse rather than send raw.
		const poison: any = { role: "assistant" };
		Object.defineProperty(poison, "content", {
			enumerable: true,
			get() {
				throw new Error("anonymizer failed mid-run");
			},
		});

		await expect(
			generateResponse({
				systemPrompt: PII_SYSTEM,
				contextMessages: [poison],
				userMessage: PII_USER,
			}),
		).rejects.toThrow(/fail-closed/i);
	});
});
