import { describe, expect, it } from "bun:test";
import {
	detectFilePaths,
	fence,
	formatMs,
	splitIntoChunks,
	summarizeToolCall,
	summarizeToolResult,
	truncateForMobile,
} from "./mobile-formatter";

describe("summarizeToolCall", () => {
	it("summarizes read_file with shortened path", () => {
		const s = summarizeToolCall("read_file", {
			path: "/Users/x/projects/repo/src/auth/handler.ts",
		});
		expect(s.label).toContain(".../auth/handler.ts");
		expect(s.icon).toBe("📄");
	});

	it("summarizes bash with command", () => {
		const s = summarizeToolCall("bash", { command: "npm test --watch" });
		expect(s.label).toContain("npm test");
		expect(s.icon).toBe("⚡");
	});

	it("summarizes web_fetch with hostname", () => {
		const s = summarizeToolCall("web_fetch", { url: "https://example.com/path/page" });
		expect(s.label).toContain("example.com");
	});

	it("falls back to a pretty name for unknown tools", () => {
		const s = summarizeToolCall("foo_bar_baz", {});
		expect(s.label).toBe("Foo Bar Baz");
	});
});

describe("summarizeToolResult", () => {
	it("includes duration and trims long output", () => {
		const long = "ok ".repeat(200);
		const out = summarizeToolResult(long, 1234);
		expect(out).toContain("...");
		expect(out).toContain("1.2s");
	});

	it("returns ok for empty output", () => {
		expect(summarizeToolResult("")).toBe("ok");
	});
});

describe("truncateForMobile", () => {
	it("preserves head and tail when over budget", () => {
		const head = "HEAD".repeat(500);
		const tail = "TAIL".repeat(500);
		const text = head + "MIDDLE_FILLER".repeat(500) + tail;
		const out = truncateForMobile(text, 800);
		expect(out.startsWith("HEAD")).toBe(true);
		expect(out.endsWith("TAIL")).toBe(true);
		expect(out).toContain("trimmed");
	});

	it("returns text unchanged when under limit", () => {
		expect(truncateForMobile("hello", 100)).toBe("hello");
	});
});

describe("splitIntoChunks", () => {
	it("returns single chunk under the limit", () => {
		expect(splitIntoChunks("hello", 1000)).toEqual(["hello"]);
	});

	it("splits long content at line boundaries", () => {
		const lines: string[] = [];
		for (let i = 0; i < 100; i++) lines.push("line ".repeat(20));
		const text = lines.join("\n");
		const chunks = splitIntoChunks(text, 500);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
	});

	it("closes open code fences when splitting mid-block", () => {
		const lines: string[] = ["```ts"];
		for (let i = 0; i < 80; i++) lines.push(`const x_${i} = ${i};`);
		lines.push("```");
		const chunks = splitIntoChunks(lines.join("\n"), 200);
		expect(chunks.length).toBeGreaterThan(1);
		// The first chunk should self-close so it parses on its own.
		const fences = (chunks[0].match(/```/g) ?? []).length;
		expect(fences % 2).toBe(0);
	});
});

describe("detectFilePaths", () => {
	it("finds typical paths in prose", () => {
		const text = "I edited /tmp/foo.png and ./src/auth.ts. See ~/notes/file.md.";
		const found = detectFilePaths(text);
		expect(found).toContain("/tmp/foo.png");
		expect(found).toContain("./src/auth.ts");
		expect(found).toContain("~/notes/file.md");
	});

	it("ignores plain words", () => {
		expect(detectFilePaths("nothing to see here")).toEqual([]);
	});
});

describe("fence + formatMs", () => {
	it("wraps text in a code fence and survives backticks", () => {
		const out = fence("```nested```", "ts");
		expect(out.startsWith("```ts\n")).toBe(true);
		expect(out.endsWith("\n```")).toBe(true);
		expect(out.includes("```nested```")).toBe(false);
	});

	it("formats milliseconds into human strings", () => {
		expect(formatMs(500)).toBe("500ms");
		expect(formatMs(1500)).toBe("1.5s");
		expect(formatMs(125000)).toBe("2m5s");
	});
});
