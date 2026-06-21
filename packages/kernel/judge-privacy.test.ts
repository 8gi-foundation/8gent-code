import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsSecret } from "../permissions/goal-secret-scrub";
import { redact } from "../memory/redact";
import { JudgeScorer } from "./judge";

// The judge runs in the cloud (OpenRouter). These guard the privacy gate that
// keeps raw user work - and any secrets in it - from ever leaving the device.
describe("judge privacy gate", () => {
	test("redaction scrubs an API key before it can be sent", () => {
		const out = redact("here is my token: sk-ABCDEFGHIJKLMNOPQRSTUVWX");
		expect(out).toContain("[REDACTED");
		expect(out).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
	});

	test("a secret that survives redaction trips containsSecret", () => {
		// redact() has no 'password=' rule, so this survives redaction...
		const survived = redact("login password = hunter2supersecret");
		expect(survived).toContain("hunter2supersecret"); // not redacted
		expect(containsSecret(survived)).toBe(true); // ...but the tripwire catches it
	});

	test("score() skips the cloud judge and returns a scrubbed neutral record when a secret survives", async () => {
		const historyPath = join(mkdtempSync(join(tmpdir(), "judge-")), "history.json");
		const scorer = new JudgeScorer({ historyPath, prmApiKey: "" });

		const origFetch = globalThis.fetch;
		let fetched = false;
		// @ts-expect-error test stub: any call here is a privacy failure
		globalThis.fetch = async () => {
			fetched = true;
			throw new Error("network must not be called for a surviving secret");
		};
		try {
			const rec = await scorer.score(
				"s1",
				0,
				"test-model",
				"deploy with password = hunter2supersecret please",
				"ok done",
			);
			expect(fetched).toBe(false); // no cloud call happened
			expect(rec.scores.overall).toBe(0); // neutral, untrained
			expect(rec.prompt).not.toContain("hunter2supersecret"); // never stored raw
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	test("score() anonymizes PII before the cloud judge sees the prompt", async () => {
		const historyPath = join(mkdtempSync(join(tmpdir(), "judge-")), "history.json");
		const scorer = new JudgeScorer({ historyPath, prmApiKey: "k" });

		const origFetch = globalThis.fetch;
		let sentBody = "";
		// @ts-expect-error test stub
		globalThis.fetch = async (_url: string, init: any) => {
			sentBody = init.body;
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"executionSuccess":0.8,"codeQuality":0.8,"toolEfficiency":0.8,"directness":0.8}',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		try {
			await scorer.score(
				"s2",
				0,
				"test-model",
				"James Spalding asked to email sarah.connor@example.com about the build.",
				"Wrote a notifier that texts +1 (415) 555-0182 when done.",
			);
			// The cloud judge payload contains NO raw PII.
			expect(sentBody).not.toContain("James Spalding");
			expect(sentBody).not.toContain("sarah.connor@example.com");
			expect(sentBody).not.toContain("555-0182");
			expect(sentBody).toMatch(/\[(PERSON|EMAIL|PHONE)_\d+\]/);
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
