/**
 * Harness HTTP surface (part of #2797). Drives handleHarnessRoute end to end
 * with real Request objects - the exact glue the daemon gateway mounts.
 *
 * Covers:
 *   - GET /harnesses lists registered harnesses + the default
 *   - POST /harness/run dispatches and returns 202 { taskId, harness }
 *   - POST /harness/run defaults to 8gent-local when harness omitted
 *   - POST /harness/run rejects missing prompt (400) and unknown harness (400)
 *   - GET /harness/tasks streams StatusEvents over SSE
 *   - non-harness paths return null so the gateway falls through
 */

import { describe, expect, it } from "bun:test";
import { handleHarnessRoute } from "../http";
import { type Harness, HarnessRegistry, type StatusEvent } from "../index";
import { HarnessRunner } from "../runner";

function instantHarness(name: string): Harness {
	return {
		name,
		async *run(task): AsyncIterable<StatusEvent> {
			const base = { agentId: task.id, harness: name, ts: Date.now() };
			yield { ...base, state: "queued" };
			yield { ...base, state: "done", output: "ok" };
		},
	};
}

function testRunner(): HarnessRunner {
	const registry = new HarnessRegistry();
	registry.register(instantHarness("8gent-local"));
	registry.register(instantHarness("other"));
	return new HarnessRunner(registry);
}

function call(
	runner: HarnessRunner,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> | Response | null {
	const url = new URL(`http://localhost:18789${path}`);
	const req = new Request(url, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return handleHarnessRoute(req, url, runner);
}

describe("harness HTTP surface", () => {
	it("returns null for non-harness paths (gateway fall-through)", () => {
		const runner = testRunner();
		expect(call(runner, "GET", "/health")).toBeNull();
		expect(call(runner, "GET", "/dispatch")).toBeNull();
	});

	it("GET /harnesses lists registered harnesses and the default", async () => {
		const res = await call(testRunner(), "GET", "/harnesses");
		expect(res).not.toBeNull();
		expect((res as Response).status).toBe(200);
		const json = await (res as Response).json();
		expect(json.harnesses).toEqual(["8gent-local", "other"]);
		expect(json.default).toBe("8gent-local");
	});

	it("POST /harness/run returns 202 with a taskId", async () => {
		const res = await call(testRunner(), "POST", "/harness/run", { prompt: "build it" });
		expect((res as Response).status).toBe(202);
		const json = await (res as Response).json();
		expect(typeof json.taskId).toBe("string");
		expect(json.harness).toBe("8gent-local");
	});

	it("POST /harness/run honours an explicit harness name", async () => {
		const res = await call(testRunner(), "POST", "/harness/run", {
			prompt: "x",
			harness: "other",
		});
		expect((res as Response).status).toBe(202);
		const json = await (res as Response).json();
		expect(json.harness).toBe("other");
	});

	it("POST /harness/run rejects a missing or empty prompt with 400", async () => {
		const noPrompt = await call(testRunner(), "POST", "/harness/run", {});
		expect((noPrompt as Response).status).toBe(400);
		const empty = await call(testRunner(), "POST", "/harness/run", { prompt: "   " });
		expect((empty as Response).status).toBe(400);
	});

	it("POST /harness/run rejects an unknown harness with 400", async () => {
		const res = await call(testRunner(), "POST", "/harness/run", {
			prompt: "x",
			harness: "devin",
		});
		expect((res as Response).status).toBe(400);
		const json = await (res as Response).json();
		expect(json.error).toContain("devin");
	});

	it("GET /harness/tasks streams StatusEvents over SSE", async () => {
		const runner = testRunner();
		const runRes = await call(runner, "POST", "/harness/run", { prompt: "stream me" });
		const { taskId } = await (runRes as Response).json();

		const sse = (await call(runner, "GET", "/harness/tasks")) as Response;
		expect(sse.status).toBe(200);
		expect(sse.headers.get("content-type")).toContain("text/event-stream");

		const reader = sse.body?.getReader();
		expect(reader).toBeDefined();
		const decoder = new TextDecoder();
		let buffer = "";
		const events: StatusEvent[] = [];
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			const { value, done } = await (reader as ReadableStreamDefaultReader).read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? ""; // keep any partial frame for the next read
			for (const frame of frames) {
				if (!frame.startsWith("data: ")) continue;
				events.push(JSON.parse(frame.slice(6)) as StatusEvent);
			}
			if (events.some((e) => e.agentId === taskId && e.state === "done")) break;
		}
		await reader?.cancel();

		const mine = events.filter((e) => e.agentId === taskId);
		expect(mine.map((e) => e.state)).toEqual(["queued", "done"]);
		expect(mine[1]?.output).toBe("ok");
	});
});
