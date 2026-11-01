import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_LINE_MAX, logLine, redact } from "./log-line";

const NOW = new Date("2026-10-28T00:00:00.000Z");
/** About 4 MB of base64, the size a day8 /dj play turn can carry (DJ_AUDIO_MAX_BYTES). */
const FOUR_MB = "QUJD".repeat(1_000_000);

describe("the daemon log never carries audio bytes", () => {
	it("a day8 /dj turn's agent:stream payload (the exact shape the gateway emits) logs as type and size", () => {
		const payload = {
			sessionId: "s1",
			chunk: "Now playing: Around the World",
			final: true,
			audio: { mime: "audio/mp4", base64: FOUR_MB },
		};
		const line = logLine("agent:stream", payload, NOW);
		expect(line.length).toBeLessThan(500);
		expect(line).not.toContain("QUJD");
		const j = JSON.parse(line.slice(line.indexOf("] ") + 2));
		expect(j.audio).toEqual({ type: "audio/mp4", size: 4_000_000 });
		expect(j.chunk).toBe("Now playing: Around the World");
		expect(j.sessionId).toBe("s1");
		expect(line.startsWith("2026-10-28T00:00:00.000Z [agent:stream] ")).toBe(true);
		expect(line.endsWith("\n")).toBe(true);
	});

	it("the class, not the instance: audio, data, bytes and base64 are redacted at any depth, in any event", () => {
		const big = "A".repeat(5000);
		const u8 = new Uint8Array(3000);
		const out = redact({
			a: { audio: big },
			b: [{ deep: { data: big } }],
			c: { bytes: u8 },
			d: { base64: big },
			e: { audio: new ArrayBuffer(10) },
		}) as {
			a: { audio: unknown };
			b: { deep: { data: unknown } }[];
			c: { bytes: unknown };
			d: { base64: unknown };
			e: { audio: unknown };
		};
		expect(out.a.audio).toEqual({ type: "string", size: 5000 });
		expect(out.b[0].deep.data).toEqual({ type: "string", size: 5000 });
		expect(out.c.bytes).toEqual({ type: "Uint8Array", size: 3000 });
		expect(out.d.base64).toEqual({ type: "string", size: 5000 });
		expect(out.e.audio).toEqual({ type: "ArrayBuffer", size: 10 });
	});

	it("keeps small, ordinary values under those names (a tool result's short data is not audio)", () => {
		expect(redact({ data: "ok", bytes: 12, audio: null, base64: "" })).toEqual({
			data: "ok",
			bytes: 12,
			audio: null,
			base64: "",
		});
		expect(redact({ tool: "read", result: { data: { n: 1 } } })).toEqual({
			tool: "read",
			result: { data: { n: 1 } },
		});
	});

	it("does not touch a long string under an ordinary name", () => {
		const text = "word ".repeat(500);
		expect((redact({ chunk: text }) as { chunk: string }).chunk).toBe(text);
	});

	it("caps a line, so no future field can write a megabyte", () => {
		const line = logLine("tool:result", { output: "x".repeat(200_000) }, NOW);
		expect(line.length).toBeLessThan(LOG_LINE_MAX + 200);
		expect(line).toContain("[truncated");
	});

	it("survives a payload that cannot be serialised", () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(logLine("agent:error", a, NOW)).toContain("[agent:error]");
		expect(logLine("agent:error", { n: 1n }, NOW)).toContain("[unserialisable]");
	});

	it("the daemon's own logger is the one that uses it (no raw JSON.stringify of a payload left in setupLogging)", () => {
		const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		const body = src.slice(src.indexOf("function setupLogging"), src.indexOf("const STATE_PATH"));
		expect(body).toContain("logLine(event, payload)");
		expect(body).not.toContain("JSON.stringify(payload)");
	});
});
