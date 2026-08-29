/**
 * Readiness vs liveness for the LM Studio client.
 *
 * The failure being pinned here is real and dated. On 2026-08-27 `/v1/models`
 * returned 200 listing `ornith-1.0-9b` while `/v1/chat/completions` timed out
 * after 300000ms, five times over three and a half hours. `isAvailable()`
 * reported healthy the whole time, so every message burned the full provider
 * timeout before failing.
 *
 * The lesson generalises past this client: a probe must ask the thing to do
 * its actual job. Anything cheaper is a proxy, and proxies report healthy
 * during exactly the outages you built them to catch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { LMStudioClient } from "./lmstudio";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Stub fetch, routing by URL so one test can make /v1/models and chat disagree. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const result = handler(url, init);
		if (result instanceof Error) throw result;
		return result as Response;
	}) as typeof fetch;
}

const json = (body: unknown, ok = true, status = 200) =>
	({ ok, status, statusText: ok ? "OK" : "Error", json: async () => body }) as Response;

const client = () => new LMStudioClient("ornith-1.0-9b", "http://127.0.0.1:1234");

describe("isReady", () => {
	test("ready when the model returns real content", async () => {
		stubFetch(() => json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
		const r = await client().isReady();
		expect(r.ready).toBe(true);
		expect(r.reason).toBeUndefined();
		expect(r.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("NOT ready when content is empty and the reasoning budget ran out", async () => {
		// The exact shape observed: a 200 response, tokens all spent on the hidden
		// thinking trace, nothing in content. Live, and useless.
		stubFetch(() =>
			json({
				choices: [
					{
						message: { content: "", reasoning_content: "Thinking Process: ..." },
						finish_reason: "length",
					},
				],
			}),
		);
		const r = await client().isReady();
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("empty content, reasoning budget exhausted");
	});

	test("NOT ready on empty content for any other reason, and names it", async () => {
		stubFetch(() => json({ choices: [{ message: { content: "   " }, finish_reason: "stop" }] }));
		const r = await client().isReady();
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("empty content (finish_reason=stop)");
	});

	test("NOT ready on a non-2xx, reporting the status", async () => {
		stubFetch(() => json({}, false, 503));
		const r = await client().isReady();
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("http 503");
	});

	test("never throws, however the transport fails", async () => {
		stubFetch(() => new Error("fetch failed"));
		const r = await client().isReady();
		expect(r.ready).toBe(false);
		expect(r.reason).toContain("fetch failed");
	});

	test("reports a timeout as a timeout, not a generic failure", async () => {
		const timeout = new Error("The operation timed out.");
		timeout.name = "TimeoutError";
		stubFetch(() => timeout);
		const r = await client().isReady();
		expect(r.ready).toBe(false);
		expect(r.reason).toContain("probe timed out after");
	});
});

describe("the bug this exists to prevent", () => {
	test("isAvailable says yes while the model cannot answer; isReady says no", async () => {
		// The 2026-08-27 outage, reproduced: model list serves fine, chat hangs.
		stubFetch((url) => {
			if (url.includes("/v1/models")) return json({ data: [{ id: "ornith-1.0-9b" }] });
			const timeout = new Error("The operation timed out.");
			timeout.name = "TimeoutError";
			return timeout;
		});

		const c = client();
		expect(await c.isAvailable()).toBe(true); // <- what we shipped before
		expect((await c.isReady()).ready).toBe(false); // <- the truth
	});
});

describe("chat is bounded", () => {
	test("passes an abort signal so a hung endpoint cannot run forever", async () => {
		let sawSignal = false;
		stubFetch((_url, init) => {
			sawSignal = Boolean(init?.signal);
			return json({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
		});
		await client().chat([{ role: "user", content: "hi" }]);
		expect(sawSignal).toBe(true);
	});
});
