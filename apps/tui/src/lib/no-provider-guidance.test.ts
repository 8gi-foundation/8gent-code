import { describe, expect, test } from "bun:test";
import {
	providerKeyStatus,
	unreachableLine,
} from "./no-provider-guidance.js";

describe("providerKeyStatus", () => {
	const lookup =
		(keys: Record<string, { needsKey: boolean; hasKey: boolean }>) => (name: string) => {
			const hit = keys[name];
			if (!hit) throw new Error("unknown");
			return hit;
		};

	test("openrouter-free uses the OpenRouter key", () => {
		const l = lookup({ openrouter: { needsKey: true, hasKey: false } });
		expect(providerKeyStatus("openrouter-free", l)).toBe("missing");
		expect(providerKeyStatus("openrouter", l)).toBe("missing");
	});

	test("key present", () => {
		expect(providerKeyStatus("groq", lookup({ groq: { needsKey: true, hasKey: true } }))).toBe(
			"present",
		);
	});

	test("local providers and lookup failures need no key", () => {
		expect(providerKeyStatus("ollama", lookup({}))).toBe("not-needed");
		expect(providerKeyStatus("mystery", lookup({}))).toBe("not-needed");
	});

	test("real registry: openrouter needs OPENROUTER_API_KEY", () => {
		const saved = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			expect(["missing", "present"]).toContain(providerKeyStatus("openrouter"));
			process.env.OPENROUTER_API_KEY = "test-key-not-real";
			expect(providerKeyStatus("openrouter")).toBe("present");
		} finally {
			if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

describe("unreachableLine", () => {
	test("names the engine and its address, says it once", () => {
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "not reachable")).toBe(
			"Ollama at 127.0.0.1:11434 did not answer.",
		);
		expect(unreachableLine("LM Studio", "localhost:1234", "no answer within 3s")).toBe(
			"LM Studio at localhost:1234 did not answer within 3s.",
		);
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "http 500")).toBe(
			"Ollama at 127.0.0.1:11434 answered with http 500.",
		);
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "no models")).toBe(
			"Ollama at 127.0.0.1:11434 has no models yet.",
		);
	});
});
