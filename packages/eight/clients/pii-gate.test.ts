/**
 * PII gate tests for the cloud LLM clients (main-agent-loop egress boundary).
 *
 * Asserts that the two cloud clients (OpenRouter, DeepSeek) route every
 * outbound message through the shared anonymizer before it leaves the machine,
 * de-anonymize the reply, leave the local path untouched, and fail closed when
 * the payload cannot be proven clean.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OllamaClient } from "./ollama";
import { OpenRouterClient } from "./openrouter";
import { DeepSeekClient } from "./deepseek";
import * as gate from "./pii-gate";
import * as anonymizer from "../../permissions/pii-anonymizer";

const PII =
	"James Spalding (jamesspaldingles@gmail.com) wants Sarah Connor called on +1 (415) 555-0182.";

const OWNER_LEAKS = ["James Spalding", "jamesspaldingles@gmail.com"];

const realFetch = globalThis.fetch;
let lastBody: any = null;

/** Stub fetch, capturing the outbound JSON body and returning a canned reply. */
function stubFetch(replyContent: string, toolArgs?: string): void {
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		lastBody = init?.body ? JSON.parse(init.body as string) : null;
		const message: any = { role: "assistant", content: replyContent };
		if (toolArgs !== undefined) {
			message.tool_calls = [{ function: { name: "notify", arguments: toolArgs } }];
		}
		return new Response(
			JSON.stringify({
				model: "test-model",
				choices: [{ message }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
}

/** Every string in the captured outbound body, flattened. */
function outboundText(): string {
	return JSON.stringify(lastBody);
}

/**
 * A message whose `content` throws on the first read (the anonymization pass)
 * but returns a benign string afterward - simulates the anonymizer raising
 * mid-run so the gate cannot prove the payload clean and must fail closed.
 */
function poisonMessage(): { role: "user"; content: string } {
	const msg = { role: "user" as const };
	let reads = 0;
	Object.defineProperty(msg, "content", {
		enumerable: true,
		get() {
			reads += 1;
			if (reads === 1) throw new Error("anonymizer failed mid-run");
			return "benign local payload";
		},
	});
	return msg as { role: "user"; content: string };
}

beforeEach(() => {
	lastBody = null;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

// ── GAP 1: OpenRouter cloud client ────────────────────────────────────────

describe("OpenRouterClient PII gate", () => {
	test("no PII (name/email/phone) appears in the outbound payload", async () => {
		stubFetch("Acknowledged.");
		const client = new OpenRouterClient("minimax/minimax-m2", "test-key");
		await client.chat([{ role: "user", content: PII }]);

		const sent = outboundText();
		for (const leak of OWNER_LEAKS) expect(sent).not.toContain(leak);
		expect(sent).not.toContain("Sarah Connor");
		expect(sent).not.toContain("555-0182");
		// Something WAS sent (pseudonyms), proving we did not just drop the turn.
		expect(sent).toContain("[EMAIL_");
		expect(sent).toContain("[PERSON_");
	});

	test("de-anonymization restores real values in the response", async () => {
		// The cloud model echoes a pseudonym back; we must restore the real value.
		// Anonymize the same text the client will, to learn the live token.
		const probe = anonymizer.anonymize(PII);
		const emailToken = [...probe.map.entries()].find(([, raw]) =>
			raw.includes("jamesspaldingles@gmail.com"),
		)?.[0];
		expect(emailToken).toBeDefined();

		stubFetch(`Reaching out to ${emailToken} now.`);
		const client = new OpenRouterClient("minimax/minimax-m2", "test-key");
		const res = await client.chat([{ role: "user", content: PII }]);

		expect(res.message.content).toContain("jamesspaldingles@gmail.com");
		expect(res.message.content).not.toContain(emailToken as string);
	});

	test("de-anonymization restores PII inside tool-call argument strings", async () => {
		const probe = anonymizer.anonymize(PII);
		const personToken = [...probe.map.entries()].find(([, raw]) =>
			raw.includes("James Spalding"),
		)?.[0];
		expect(personToken).toBeDefined();

		stubFetch("done", JSON.stringify({ to: personToken }));
		const client = new OpenRouterClient("minimax/minimax-m2", "test-key");
		const res = await client.chat([{ role: "user", content: PII }]);

		const args = res.message.tool_calls?.[0]?.function.arguments ?? "";
		expect(args).toContain("James Spalding");
		expect(args).not.toContain(personToken as string);
	});

	test("fail-closed: poisoned anonymizer reroutes to local, never sends raw to cloud", async () => {
		// Drive the gate's fail-closed path WITHOUT mocking the anonymizer module
		// (a mock.module poisons the shared registry for the whole bun process).
		// A message whose content getter throws on the anonymization read makes
		// anonymizeOutbound report not-clean; the client must reroute to local.
		let cloudHit = false;
		let localHit = false;
		globalThis.fetch = (async (url: string) => {
			if (/openrouter\.ai/.test(String(url))) cloudHit = true;
			if (/11434/.test(String(url))) localHit = true;
			return new Response(
				JSON.stringify({ message: { role: "assistant", content: "local-ok" }, eval_count: 1 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const client = new OpenRouterClient("minimax/minimax-m2", "test-key");
		const res = await client.chat([poisonMessage()]);
		expect(cloudHit).toBe(false); // raw NEVER went to cloud
		expect(localHit).toBe(true); // rerouted to local Ollama
		expect(res.message.content).toBe("local-ok");
	});
});

// ── GAP 1: DeepSeek cloud client ──────────────────────────────────────────

describe("DeepSeekClient PII gate", () => {
	test("no PII appears in the outbound payload", async () => {
		stubFetch("ok");
		const client = new DeepSeekClient("deepseek-v4-flash", "test-key");
		await client.chat([{ role: "user", content: PII }]);

		const sent = outboundText();
		for (const leak of OWNER_LEAKS) expect(sent).not.toContain(leak);
		expect(sent).not.toContain("Sarah Connor");
		expect(sent).toContain("[PERSON_");
	});

	test("de-anonymizes the response content", async () => {
		const probe = anonymizer.anonymize(PII);
		const emailToken = [...probe.map.entries()].find(([, raw]) =>
			raw.includes("jamesspaldingles@gmail.com"),
		)?.[0];
		stubFetch(`Mailing ${emailToken}.`);
		const client = new DeepSeekClient("deepseek-v4-flash", "test-key");
		const res = await client.chat([{ role: "user", content: PII }]);
		expect(res.message.content).toContain("jamesspaldingles@gmail.com");
	});
});

// ── Local path is untouched ───────────────────────────────────────────────

describe("local clients are NOT gated", () => {
	test("OllamaClient sends raw messages (on-device, no anonymization)", async () => {
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			lastBody = init?.body ? JSON.parse(init.body as string) : null;
			return new Response(
				JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 1 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const client = new OllamaClient("qwen3:latest");
		await client.chat([{ role: "user", content: PII }]);

		const sent = outboundText();
		// Local data stays on-device, so the model sees the REAL values.
		expect(sent).toContain("James Spalding");
		expect(sent).toContain("jamesspaldingles@gmail.com");
		expect(sent).not.toContain("[PERSON_");
	});
});

// ── gate helper unit coverage ─────────────────────────────────────────────

describe("anonymizeOutbound / deanonymizeResponse", () => {
	test("anonymizeOutbound masks then verifies clean", () => {
		const g = gate.anonymizeOutbound([{ role: "user", content: PII }]);
		expect(g.clean).toBe(true);
		expect(g.messages[0].content).not.toContain("James Spalding");
		expect(g.map.size).toBeGreaterThan(0);
	});

	test("no-PII payload passes through clean with empty map", () => {
		const g = gate.anonymizeOutbound([{ role: "user", content: "list the open issues" }]);
		expect(g.clean).toBe(true);
		expect(g.map.size).toBe(0);
		expect(g.messages[0].content).toBe("list the open issues");
	});
});
