/**
 * #72 stream rules: an optional ~/.8gent/stream-rules.json holds
 * {pattern, correction, max_retries} rules. While a reply streams, a match
 * aborts that generation, appends the correction as a system note and retries
 * once. With no file nothing changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTextToolCall } from "../ai/text-tool-endpoint";
import { loadStreamRules, streamGuard, streamRulesPath } from "./stream-rules";

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: string) => sse({ choices: [{ index: 0, delta: { content } }] });

let home: string;
const write = (body: string) => {
	mkdirSync(join(home, ".8gent"), { recursive: true });
	writeFileSync(join(home, ".8gent", "stream-rules.json"), body);
};
const env = () => ({ HOME: home }) as Record<string, string>;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "stream-rules-"));
});
afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("loadStreamRules", () => {
	it("no file: null, so the feature is off", () => {
		expect(loadStreamRules(env())).toBeNull();
		expect(streamGuard(env())).toBeUndefined();
	});

	it("reads rules from <home>/.8gent/stream-rules.json", () => {
		write(JSON.stringify([{ pattern: "as an AI", correction: "Do not say that.", max_retries: 1 }]));
		expect(streamRulesPath(env())).toBe(join(home, ".8gent", "stream-rules.json"));
		const rules = loadStreamRules(env());
		expect(rules?.length).toBe(1);
		expect(streamGuard(env())?.("well, as an AI I think")).toBe("Do not say that.");
		expect(streamGuard(env())?.("fine reply")).toBeNull();
	});

	it("bad JSON, a bad regex, a multi-line correction and max_retries other than 1 are dropped, not thrown", () => {
		write(
			JSON.stringify([
				{ pattern: "(", correction: "x", max_retries: 1 },
				{ pattern: "ok", correction: "two\nlines", max_retries: 1 },
				{ pattern: "ok", correction: "fine", max_retries: 5 },
				{ pattern: "keep", correction: "kept", max_retries: 1 },
			]),
		);
		expect(loadStreamRules(env())?.map((r) => r.correction)).toEqual(["kept"]);
		write("{not json");
		expect(loadStreamRules(env())).toBeNull();
	});
});

describe("buildTextToolCall with a stream guard", () => {
	let server: ReturnType<typeof Bun.serve>;
	let base = "";
	const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
	let replies: string[][] = [];

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				bodies.push(await req.json());
				const parts = replies[Math.min(bodies.length - 1, replies.length - 1)];
				const chunks = [...parts.map(delta), sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"];
				return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		base = `http://127.0.0.1:${server.port}/v1/chat/completions`;
	});
	afterAll(() => server.stop(true));

	const guard = (t: string) => (/forbidden/.test(t) ? "Never say the forbidden word." : null);
	const make = (g?: (t: string) => string | null) =>
		buildTextToolCall({ provider: "ollama", model: "m", endpoint: base, timeoutMs: 5_000, idleMs: 2_000, streamGuard: g });

	it("a match aborts the generation, appends the correction as a system note and retries once", async () => {
		bodies.length = 0;
		replies = [["this is ", "forbid", "den text"], ["a clean answer"]];
		const out = await make(guard)([{ role: "user", content: "hi" }]);
		expect(out).toBe("a clean answer");
		expect(bodies.length).toBe(2);
		expect(bodies[1].messages.at(-1)).toEqual({ role: "system", content: "Never say the forbidden word." });
		expect(bodies[1].messages.length).toBe(bodies[0].messages.length + 1);
	});

	it("at most one retry per turn: a second match is returned as is", async () => {
		bodies.length = 0;
		replies = [["forbidden one"], ["forbidden two"]];
		const call = make(guard);
		expect(await call([{ role: "user", content: "hi" }])).toBe("forbidden two");
		expect(bodies.length).toBe(2);
		// the same call function (same turn) does not retry again
		bodies.length = 0;
		replies = [["forbidden three"]];
		expect(await call([{ role: "user", content: "hi" }])).toBe("forbidden three");
		expect(bodies.length).toBe(1);
	});

	it("no guard: one request, reply untouched", async () => {
		bodies.length = 0;
		replies = [["forbidden but unguarded"]];
		expect(await make(undefined)([{ role: "user", content: "hi" }])).toBe("forbidden but unguarded");
		expect(bodies.length).toBe(1);
	});

	it("a clean reply under a guard is one request", async () => {
		bodies.length = 0;
		replies = [["all good"]];
		expect(await make(guard)([{ role: "user", content: "hi" }])).toBe("all good");
		expect(bodies.length).toBe(1);
	});
});
