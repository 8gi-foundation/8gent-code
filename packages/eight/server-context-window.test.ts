/**
 * #3643: an Ollama session reads the server's real context window once, the
 * first time the history nears the 32768 fallback's compaction line, and
 * resizes both compactors to it. The lookup is injected; nothing touches the
 * network and no model runs. The long message is synthetic text.
 */

import { expect, test } from "bun:test";
import { Agent } from "./agent";
import { ProactiveCompression } from "./compaction";

type Inner = {
	messageHistory: Array<{ role: string; content: string }>;
	compaction: ProactiveCompression;
	compactionContextWindow: number;
	contextWindowLookup: (a: { baseUrl: string; model: string }) => Promise<number | null>;
	readServerContextWindow: () => Promise<void>;
};

function agent(runtime = "ollama"): Inner {
	return new Agent({ model: "qwen-fake:27b", runtime } as ConstructorParameters<typeof Agent>[0]) as unknown as Inner;
}

// About 30k tokens of synthetic text (4 characters per token).
const LONG = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2_200);

function lookupReturning(value: number | null) {
	const calls: Array<{ baseUrl: string; model: string }> = [];
	const fn = async (a: { baseUrl: string; model: string }) => {
		calls.push(a);
		return value;
	};
	return { fn, calls };
}

test("a short session never asks the server", async () => {
	const a = agent();
	const look = lookupReturning(262144);
	a.contextWindowLookup = look.fn;
	a.messageHistory = [{ role: "user", content: "hi" }];
	await a.readServerContextWindow();
	expect(look.calls).toHaveLength(0);
	expect(a.compactionContextWindow).toBe(32768);
});

test("a long first message reads the real window once and compaction no longer fires", async () => {
	const a = agent();
	const look = lookupReturning(262144);
	a.contextWindowLookup = look.fn;
	a.messageHistory = [{ role: "user", content: LONG }];
	expect(a.compaction.shouldCompact(a.messageHistory as never)).toBe(true);
	await a.readServerContextWindow();
	await a.readServerContextWindow();
	expect(look.calls).toHaveLength(1);
	expect(look.calls[0]?.model).toBe("qwen-fake:27b");
	expect(a.compactionContextWindow).toBe(262144);
	expect(a.compaction.shouldCompact(a.messageHistory as never)).toBe(false);
});

test("an unreadable server keeps the fallback", async () => {
	const a = agent();
	a.contextWindowLookup = lookupReturning(null).fn;
	a.messageHistory = [{ role: "user", content: LONG }];
	await a.readServerContextWindow();
	expect(a.compactionContextWindow).toBe(32768);
});

test("a compactor replaced after construction is left alone", async () => {
	const a = agent();
	const look = lookupReturning(262144);
	a.contextWindowLookup = look.fn;
	const replaced = new ProactiveCompression({ contextWindow: 1000 });
	a.compaction = replaced;
	a.messageHistory = [{ role: "user", content: LONG }];
	await a.readServerContextWindow();
	expect(look.calls).toHaveLength(0);
	expect(a.compaction).toBe(replaced);
});

test("a cloud runtime never asks", async () => {
	const a = agent("anthropic");
	const look = lookupReturning(262144);
	a.contextWindowLookup = look.fn;
	a.messageHistory = [{ role: "user", content: LONG.repeat(10) }];
	await a.readServerContextWindow();
	expect(look.calls).toHaveLength(0);
});
