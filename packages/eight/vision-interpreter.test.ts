import { afterEach, describe, expect, it } from "bun:test";
import { oneLineError, visionTimeoutMs } from "./vision-interpreter";

describe("visionTimeoutMs (#3724)", () => {
	it("defaults to 180000", () => expect(visionTimeoutMs({})).toBe(180000));
	it("honours EIGHT_VISION_TIMEOUT_MS", () =>
		expect(visionTimeoutMs({ EIGHT_VISION_TIMEOUT_MS: "5000" })).toBe(5000));
	it("ignores junk and non-positive values", () => {
		expect(visionTimeoutMs({ EIGHT_VISION_TIMEOUT_MS: "abc" })).toBe(180000);
		expect(visionTimeoutMs({ EIGHT_VISION_TIMEOUT_MS: "0" })).toBe(180000);
		expect(visionTimeoutMs({ EIGHT_VISION_TIMEOUT_MS: "-1" })).toBe(180000);
	});
});

describe("oneLineError (#3724)", () => {
	it("strips newlines and control characters", () =>
		expect(oneLineError("a\nb\r\tc\u0007d")).toBe("a b c d"));
	it("caps at 200 chars", () => expect(oneLineError("x".repeat(500)).length).toBe(200));
});

describe("callVisionModel request (#3724)", () => {
	const real = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = real;
	});
	it("sends keep_alive and an abort signal to Ollama", async () => {
		let body: any;
		let signal: AbortSignal | undefined;
		globalThis.fetch = (async (_u: any, init: any) => {
			body = JSON.parse(init.body);
			signal = init.signal;
			return new Response(JSON.stringify({ message: { content: "ok" } }));
		}) as any;
		const { callVisionModel } = await import("./vision-interpreter");
		const out = await callVisionModel(
			{ provider: "ollama", model: "qwen2.5vl:7b", free: true } as any,
			"AAAA",
			"image/png",
			"describe",
		);
		expect(out).toBe("ok");
		expect(body.keep_alive).toBe("10m");
		expect(signal).toBeDefined();
	});
});
