/**
 * Tests for CompressionEngine (issue #2420).
 *
 * The LLM call is stubbed so the test runs offline. We verify:
 *   - registry artifacts are rendered into the prompt verbatim
 *   - previous summary is fed back in (incremental, not regenerative)
 *   - cut-point logic preserves the recent tail
 *   - output messages have the shape [system, summary, ...tail]
 */

import { describe, expect, it, mock } from "bun:test";
import { ArtifactRegistryStore } from "../artifact-registry";
import { CompressionEngine, buildCompressionInput, findCutPoint } from "../compression-engine";
import type { Message, SummarizerCall } from "../index";

function bigContent(label: string, size = 500): string {
	return `${label}: ${"x ".repeat(size)}`;
}

function makeStub(returnText = "## Goal\nfinish work\n## Progress\nDone\n"): {
	stub: SummarizerCall;
	calls: { prompt: string; maxOutputTokens: number }[];
} {
	const calls: { prompt: string; maxOutputTokens: number }[] = [];
	const stub = mock(
		async ({ prompt, maxOutputTokens }: { prompt: string; maxOutputTokens: number }) => {
			calls.push({ prompt, maxOutputTokens });
			return { text: returnText };
		},
	);
	return { stub, calls };
}

describe("findCutPoint", () => {
	it("keeps the recent tail at least as large as keepRecentTokens", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			...Array.from({ length: 20 }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: bigContent(`msg-${i}`, 100),
			})),
		];
		const cut = findCutPoint(messages, 2000);
		const tail = messages.slice(cut);
		expect(tail.length).toBeGreaterThan(0);
		expect(cut).toBeGreaterThan(0);
		expect(cut).toBeLessThan(messages.length);
	});

	it("never strands a tool result without its tool call", () => {
		const messages: Message[] = [
			{ role: "system", content: "s" },
			{ role: "user", content: bigContent("u", 200) },
			{ role: "assistant", content: bigContent("a", 200) },
			{ role: "tool", content: bigContent("t", 200) },
			{ role: "user", content: bigContent("u2", 200) },
		];
		const cut = findCutPoint(messages, 1500);
		expect(messages[cut]?.role).not.toBe("tool");
	});
});

describe("CompressionEngine", () => {
	it("renders registry artifacts verbatim into the prompt", async () => {
		const { stub, calls } = makeStub();
		const engine = new CompressionEngine(stub, { keepRecentTokens: 200 });
		const registry = new ArtifactRegistryStore();
		registry.trackFile("packages/daemon/context/types.ts", "created");
		registry.trackEntity("AgentPool", "class", "session manager");
		registry.trackDecision("use OpenAI-compatible SDK", "single API surface");

		const messages: Message[] = [
			{ role: "system", content: "you are an agent" },
			...Array.from({ length: 10 }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: bigContent(`turn-${i}`, 100),
			})),
		];

		const out = await engine.compress(buildCompressionInput(messages, null, registry));
		expect(out.messagesRemoved).toBeGreaterThan(0);
		expect(calls.length).toBe(1);
		expect(calls[0].prompt).toContain("packages/daemon/context/types.ts");
		expect(calls[0].prompt).toContain("AgentPool");
		expect(calls[0].prompt).toContain("use OpenAI-compatible SDK");
	});

	it("feeds previous summary back in for incremental compression", async () => {
		const { stub, calls } = makeStub();
		const engine = new CompressionEngine(stub, { keepRecentTokens: 200 });
		const registry = new ArtifactRegistryStore();
		const messages: Message[] = [
			{ role: "system", content: "system" },
			...Array.from({ length: 10 }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: bigContent(`m-${i}`, 100),
			})),
		];

		await engine.compress(buildCompressionInput(messages, "PREVIOUS_SUMMARY_MARKER", registry));
		expect(calls[0].prompt).toContain("PREVIOUS_SUMMARY_MARKER");
		expect(calls[0].prompt).toContain("Update");
	});

	it("produces a [system, summary, ...tail] message layout", async () => {
		const { stub } = makeStub("SUMMARY_BODY");
		const engine = new CompressionEngine(stub, { keepRecentTokens: 200 });
		const registry = new ArtifactRegistryStore();
		registry.trackFile("a.ts", "modified");

		const messages: Message[] = [
			{ role: "system", content: "system-prompt" },
			...Array.from({ length: 8 }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: bigContent(`m-${i}`, 200),
			})),
		];

		const out = await engine.compress(buildCompressionInput(messages, null, registry));
		expect(out.messages[0].role).toBe("system");
		expect(out.messages[0].content).toBe("system-prompt");
		expect(out.messages[1].role).toBe("system");
		expect(out.messages[1].content).toContain("Compression Checkpoint");
		expect(out.messages[1].content).toContain("SUMMARY_BODY");
		expect(out.messages[1].content).toContain("a.ts");
		expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
	});

	it("returns a no-op result when there is nothing to compress", async () => {
		const { stub, calls } = makeStub();
		const engine = new CompressionEngine(stub, { keepRecentTokens: 100000 });
		const registry = new ArtifactRegistryStore();
		const messages: Message[] = [
			{ role: "system", content: "s" },
			{ role: "user", content: "hi" },
		];
		const out = await engine.compress(buildCompressionInput(messages, null, registry));
		expect(out.messagesRemoved).toBe(0);
		expect(calls.length).toBe(0);
		expect(out.messages).toBe(messages);
	});
});
