/**
 * Streamed replies must restore masked placeholders even when the model splits
 * a placeholder like `[EMAIL_1]` across several stream chunks (#3545).
 *
 * Two layers: the stream restorer in pii-anonymizer, and the DeepSeek stream()
 * path that ships it, driven by a stubbed SSE response (no network).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isolateOwnerIdentity } from "../../permissions/__tests__/isolated-owner-identity";
import * as anonymizer from "../../permissions/pii-anonymizer";
import { DeepSeekClient } from "./deepseek";

isolateOwnerIdentity();

const MAP = new Map<string, string>([
	["[EMAIL_1]", "sarah.connor@example.com"],
	["[PERSON_1]", "Sarah Connor"],
	["[PERSON_10]", "Kyle Reese"],
]);

function runStream(chunks: string[], map: Map<string, string>): string {
	const r = anonymizer.createStreamDeanonymizer(map);
	let out = "";
	for (const c of chunks) out += r.push(c);
	return out + r.flush();
}

/** Every way to cut `text` into two pieces, plus a one-char-per-chunk split. */
function splits(text: string): string[][] {
	const all: string[][] = [];
	for (let i = 1; i < text.length; i++) all.push([text.slice(0, i), text.slice(i)]);
	all.push([...text]);
	return all;
}

describe("createStreamDeanonymizer", () => {
	test("restores a placeholder split into the pieces a tokenizer emits", () => {
		const chunks = ["Sure, I will write to ", "[", "EMAIL_", "1", "]", " now."];
		expect(runStream(chunks, MAP)).toBe("Sure, I will write to sarah.connor@example.com now.");
	});

	test("every split position matches the whole-string restore", () => {
		const reply = "Ask [PERSON_1] and [PERSON_10] to mail [EMAIL_1] [ok] [EMAIL_";
		const expected = anonymizer.deanonymize(reply, MAP);
		let mismatches = 0;
		for (const chunks of splits(reply)) {
			if (runStream(chunks, MAP) !== expected) mismatches++;
		}
		expect(mismatches).toBe(0);
	});

	test("text that cannot become a placeholder is not held back", () => {
		const r = anonymizer.createStreamDeanonymizer(MAP);
		expect(r.push("plain text [ok] ")).toBe("plain text [ok] ");
		expect(r.push("array[0]")).toBe("array[0]");
		expect(r.flush()).toBe("");
	});

	test("a lone open bracket is held, then released unchanged on flush", () => {
		const r = anonymizer.createStreamDeanonymizer(MAP);
		expect(r.push("see [")).toBe("see ");
		expect(r.flush()).toBe("[");
	});

	test("an empty map passes chunks through untouched", () => {
		const r = anonymizer.createStreamDeanonymizer(new Map());
		expect(r.push("[EMAIL_")).toBe("[EMAIL_");
		expect(r.flush()).toBe("");
	});
});

describe("DeepSeekClient.stream restores split placeholders", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function stubSse(deltas: string[], withDone: boolean): void {
		const lines = deltas.map(
			(d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`,
		);
		if (withDone) lines.push("data: [DONE]\n\n");
		globalThis.fetch = (async () =>
			new Response(lines.join(""), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			})) as unknown as typeof fetch;
	}

	async function collect(withDone: boolean): Promise<string> {
		const email = "sarah.connor@example.com";
		const client = new DeepSeekClient("deepseek-v4-flash", "test-key");
		// The gate masks the only email in the prompt as [EMAIL_1].
		stubSse(["Writing to ", "[", "EMAIL_", "1", "]", " now. See [ok"], withDone);
		let out = "";
		for await (const piece of client.stream([{ role: "user", content: `Email ${email}` }])) {
			out += piece;
		}
		return out;
	}

	test("with a [DONE] terminator", async () => {
		expect(await collect(true)).toBe("Writing to sarah.connor@example.com now. See [ok");
	});

	test("when the body ends without [DONE]", async () => {
		expect(await collect(false)).toBe("Writing to sarah.connor@example.com now. See [ok");
	});
});
