/**
 * Tests for local-model tool routing integrity.
 *
 * Regression coverage for two bugs found dogfooding the lmstudio path live:
 *  - ornith (tool-capable) was forced into text-tools by a provider-coarse gate.
 *  - gemma claimed file writes that never landed on disk.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetNativeToolCache,
	buildWriteHonestyNote,
	modelSupportsNativeTools,
	type WriteOutcome,
} from "./local-tool-routing.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	__resetNativeToolCache();
});

function stubFetch(impl: () => Promise<Response> | Response): { calls: number } {
	const state = { calls: 0 };
	globalThis.fetch = (async () => {
		state.calls++;
		return impl();
	}) as typeof fetch;
	return state;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("modelSupportsNativeTools", () => {
	it("returns true when the model emits native tool_calls (ornith)", async () => {
		stubFetch(() =>
			jsonResponse({
				choices: [{ message: { tool_calls: [{ function: { name: "report_ready" } }] } }],
			}),
		);
		const ok = await modelSupportsNativeTools({
			provider: "lmstudio",
			model: "ornith-1.0-9b",
			endpoint: "http://localhost:1234/v1/chat/completions",
		});
		expect(ok).toBe(true);
	});

	it("returns false when the template rejects the tools payload (gemma)", async () => {
		stubFetch(() =>
			jsonResponse(
				{ error: "Error rendering prompt with jinja template: Cannot call ..." },
				false,
				400,
			),
		);
		const ok = await modelSupportsNativeTools({
			provider: "lmstudio",
			model: "gemma-4-12b-coder",
			endpoint: "http://localhost:1234/v1/chat/completions",
		});
		expect(ok).toBe(false);
	});

	it("returns true when the template accepts tools even without a probe tool_call", async () => {
		// A capable model may decline to call a throwaway health-check tool; the
		// template still rendered the payload, so it is native-capable.
		stubFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
		const ok = await modelSupportsNativeTools({
			provider: "lmstudio",
			model: "ornith-1.0-9b",
			endpoint: "http://localhost:1234/v1/chat/completions",
		});
		expect(ok).toBe(true);
	});

	it("returns false on a 200 body that carries an error (template render failure)", async () => {
		stubFetch(() => jsonResponse({ error: "Error rendering prompt with jinja template" }));
		const ok = await modelSupportsNativeTools({
			provider: "lmstudio",
			model: "gemma-4-12b-coder",
			endpoint: "http://localhost:1234/v1/chat/completions",
		});
		expect(ok).toBe(false);
	});

	it("returns false (safe default) when the endpoint is unreachable", async () => {
		stubFetch(() => {
			throw new Error("fetch failed");
		});
		const ok = await modelSupportsNativeTools({
			provider: "ollama",
			model: "llama3.2:3b",
			endpoint: "http://localhost:11434/v1/chat/completions",
		});
		expect(ok).toBe(false);
	});

	it("caches the probe result per provider:model (no second request)", async () => {
		const state = stubFetch(() =>
			jsonResponse({
				choices: [{ message: { tool_calls: [{ function: { name: "report_ready" } }] } }],
			}),
		);
		const opts = {
			provider: "lmstudio",
			model: "ornith-1.0-9b",
			endpoint: "http://localhost:1234/v1/chat/completions",
		};
		expect(await modelSupportsNativeTools(opts)).toBe(true);
		expect(await modelSupportsNativeTools(opts)).toBe(true);
		expect(state.calls).toBe(1);
	});
});

describe("buildWriteHonestyNote", () => {
	it("flags a write tool that ran and failed, naming the path", () => {
		const writes: WriteOutcome[] = [
			{ path: "launch-report.html", ok: false, reason: "[BLOCKED] outside working directory" },
		];
		const note = buildWriteHonestyNote("Saved the report to launch-report.html.", writes);
		expect(note).toContain("launch-report.html");
		expect(note).toContain("NOT written");
		expect(note).toContain("outside working directory");
	});

	it("flags a claimed save when no write tool ran (gemma narration)", () => {
		const note = buildWriteHonestyNote(
			"The launch report has been generated and saved to launch-report.html.",
			[],
		);
		expect(note).toContain("no write tool ran");
	});

	it("stays silent when a write actually succeeded", () => {
		const writes: WriteOutcome[] = [{ path: "launch-report.html", ok: true }];
		const note = buildWriteHonestyNote("Saved the report to launch-report.html.", writes);
		expect(note).toBe("");
	});

	it("stays silent when the reply makes no write claim", () => {
		expect(buildWriteHonestyNote("Here is a summary of the launch prep.", [])).toBe("");
	});

	it("stays silent when a blocked path was retried and then succeeded", () => {
		const writes: WriteOutcome[] = [
			{ path: "report.html", ok: false, reason: "path traversal blocked" },
			{ path: "report.html", ok: true },
		];
		expect(buildWriteHonestyNote("Saved to report.html.", writes)).toBe("");
	});

	it("does not false-positive on a future-tense intention", () => {
		expect(buildWriteHonestyNote("I will write the report to report.html next.", [])).toBe("");
	});
});
