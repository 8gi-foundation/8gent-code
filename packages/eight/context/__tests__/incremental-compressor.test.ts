import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";
import { IncrementalContextCompressor, presetFor } from "../incremental-compressor";
import { extractPaths, intersectionRatio } from "../metrics";

/**
 * The underlying ProactiveCompression calls `generateText({ model, ... })` from
 * the `ai` package. We don't want a real model in tests, so we hand it a fake
 * LanguageModel that satisfies the AI SDK's `doGenerate` contract just enough.
 *
 * The shape changes between SDK versions. To stay decoupled, the integration
 * tests below assert behavior that does NOT require a model call:
 *   - decideTrigger logic
 *   - registry injection (manual call path with a stub)
 *   - milestone accumulation + reset
 *   - metrics arithmetic
 */

describe("IncrementalContextCompressor — preset selection", () => {
	it("returns interactive preset by default", () => {
		const c = new IncrementalContextCompressor("s1");
		expect(c.getConfig().sessionType).toBe("interactive");
	});

	it("each session type has distinct milestone gating", () => {
		const a = presetFor("interactive").milestone;
		const b = presetFor("telegram").milestone;
		expect(a.minMessagesSinceLast).not.toBe(b.minMessagesSinceLast);
	});

	it("user overrides merge into preset", () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "telegram",
			milestone: { minConfidence: 0.99, minMessagesSinceLast: 6, minTokensSinceLast: 1500 },
		});
		expect(c.getConfig().sessionType).toBe("telegram");
		expect(c.getConfig().milestone.minConfidence).toBe(0.99);
	});
});

describe("IncrementalContextCompressor — milestone trigger gating", () => {
	const messages = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			role: i === 0 ? "system" : i % 2 === 1 ? "user" : "assistant",
			content: "x".repeat(800),
		}));

	it("returns null when no milestones and no token pressure", () => {
		const c = new IncrementalContextCompressor("s1", { sessionType: "interactive" });
		expect(c.decideTrigger(messages(4), 100_000)).toBeNull();
	});

	it("returns 'milestone' when a high-confidence tool call milestone fires AND growth threshold met", () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "interactive",
			milestone: { minMessagesSinceLast: 2, minTokensSinceLast: 1000, minConfidence: 0.5 },
		});
		c.noteToolCall({
			name: "Write",
			args: { file_path: "src/foo.ts" },
			success: true,
		});
		expect(c.decideTrigger(messages(20), 100_000)).toBe("milestone");
	});

	it("returns null when milestone fires but conversation hasn't grown enough", () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "interactive",
			milestone: { minMessagesSinceLast: 100, minTokensSinceLast: 999_999, minConfidence: 0.5 },
		});
		c.noteToolCall({
			name: "Write",
			args: { file_path: "src/foo.ts" },
			success: true,
		});
		expect(c.decideTrigger(messages(4), 100_000)).toBeNull();
	});

	it("'token_pressure' takes precedence over milestone when context window is tiny", () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "interactive",
			milestone: { minMessagesSinceLast: 2, minTokensSinceLast: 1000, minConfidence: 0.5 },
		});
		c.noteToolCall({
			name: "Write",
			args: { file_path: "src/foo.ts" },
			success: true,
		});
		expect(c.decideTrigger(messages(20), 1000)).toBe("token_pressure");
	});
});

describe("IncrementalContextCompressor — registry artifact tracking", () => {
	it("records files from Read/Write tool calls in the registry", () => {
		const c = new IncrementalContextCompressor("s1");
		c.noteToolCall({ name: "Read", args: { file_path: "a.ts" }, success: true });
		c.noteToolCall({ name: "Write", args: { file_path: "b.ts" }, success: true });
		expect(c.registry.has("file", "a.ts")).toBe(true);
		expect(c.registry.has("file", "b.ts")).toBe(true);
	});

	it("records errors for failed tool calls", () => {
		const c = new IncrementalContextCompressor("s1");
		c.noteToolCall({
			name: "Bash",
			args: { command: "bun test" },
			resultPreview: "Error: cannot find module",
			success: false,
		});
		expect(c.registry.size("error")).toBeGreaterThan(0);
	});

	it("records decisions from assistant text", () => {
		const c = new IncrementalContextCompressor("s1");
		c.noteAssistantText("I'll go with SQLite for the local store.");
		expect(c.registry.size("decision")).toBeGreaterThan(0);
	});

	it("records bash commands", () => {
		const c = new IncrementalContextCompressor("s1");
		c.noteToolCall({
			name: "Bash",
			args: { command: "git status" },
			resultPreview: "clean",
			success: true,
		});
		expect(c.registry.size("command")).toBe(1);
	});
});

describe("compress — registry injection (no LLM, fake model)", () => {
	// Minimal fake model that just returns a canned summary. Compatible with the
	// underlying `generateText({ model, prompt, maxOutputTokens })` call.
	const fakeModel = {
		specificationVersion: "v2",
		provider: "fake",
		modelId: "fake-summary",
		supportedUrls: {},
		async doGenerate() {
			return {
				content: [{ type: "text", text: "## Summary\nfake summary" }],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				request: { body: "" },
				response: { id: "1", timestamp: new Date(), modelId: "fake" },
			};
		},
		async doStream() {
			throw new Error("not implemented");
		},
	} as unknown as LanguageModel;

	it("re-injects the artifact registry block after compression", async () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "interactive",
			milestone: { minMessagesSinceLast: 1, minTokensSinceLast: 1, minConfidence: 0.5 },
		});
		c.noteToolCall({ name: "Write", args: { file_path: "src/keep-this.ts" }, success: true });

		// Build a long conversation to force the engine into a real summarize stage.
		const long = [
			{ role: "system", content: "You are a coder." },
			...Array.from({ length: 60 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: "x".repeat(500),
			})),
		];
		const out = await c.compress(long, fakeModel, {
			trigger: "milestone",
			contextWindow: 8000,
		});
		// Registry block must appear in at least one system message.
		const hasRegistryBlock = out.messages.some(
			(m) => m.role === "system" && m.content.includes("Artifact Registry"),
		);
		expect(hasRegistryBlock).toBe(true);
		// The file path we registered before compression must survive in the
		// post-compression message stream — even if the raw user/assistant turns
		// that mentioned it have been summarized away.
		const allText = out.messages.map((m) => m.content).join("\n");
		expect(allText).toContain("src/keep-this.ts");
	});

	it("records a metric per compress() call with valid retention values", async () => {
		const c = new IncrementalContextCompressor("s1", {
			sessionType: "telegram",
			milestone: { minMessagesSinceLast: 1, minTokensSinceLast: 1, minConfidence: 0.5 },
		});
		c.noteToolCall({ name: "Read", args: { file_path: "config.ts" }, success: true });
		const long = [
			{ role: "system", content: "sys" },
			...Array.from({ length: 40 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: "y".repeat(400),
			})),
		];
		await c.compress(long, fakeModel, { trigger: "manual", contextWindow: 6000 });

		const snap = c.metrics.snapshot();
		expect(snap.totalCompressions).toBe(1);
		expect(snap.byTrigger.manual).toBe(1);
		expect(snap.avgArtifactRetention).toBeGreaterThanOrEqual(0);
		expect(snap.avgArtifactRetention).toBeLessThanOrEqual(1);
		expect(snap.avgReferenceRetention).toBeGreaterThanOrEqual(0);
		expect(snap.avgReferenceRetention).toBeLessThanOrEqual(1);
	});
});

describe("metrics helpers", () => {
	it("extractPaths finds typescript file paths", () => {
		const paths = extractPaths("read packages/eight/context/foo.ts then a.json");
		expect(paths.has("packages/eight/context/foo.ts")).toBe(true);
		expect(paths.has("a.json")).toBe(true);
	});

	it("intersectionRatio returns 1 when a is empty", () => {
		expect(intersectionRatio(new Set(), new Set(["x"]))).toBe(1);
	});

	it("intersectionRatio returns hit fraction over a", () => {
		const a = new Set(["a", "b", "c", "d"]);
		const b = new Set(["a", "b"]);
		expect(intersectionRatio(a, b)).toBe(0.5);
	});
});
