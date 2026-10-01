import { describe, expect, test } from "bun:test";
import {
	needsProviderGuidance,
	providerKeyStatus,
	unreachableLine,
} from "./no-provider-guidance.js";

describe("needsProviderGuidance (T5)", () => {
	const base = {
		checked: true,
		liveLocal: 0,
		provider: "ollama",
		keyStatus: "not-needed" as const,
	};

	test("local provider, no engine answering: show", () => {
		for (const provider of ["", "8gent", "ollama", "lmstudio", "llama-server", "apfel"]) {
			expect(needsProviderGuidance({ ...base, provider })).toBe(true);
		}
	});

	test("local provider, an engine answering: hide", () => {
		expect(needsProviderGuidance({ ...base, liveLocal: 1 })).toBe(false);
	});

	test("not checked yet: hide, so it never flashes", () => {
		expect(needsProviderGuidance({ ...base, checked: false })).toBe(false);
	});

	test("hosted provider: shows only when its key is missing", () => {
		const hosted = { ...base, provider: "openrouter" };
		expect(needsProviderGuidance({ ...hosted, keyStatus: "missing" })).toBe(true);
		expect(needsProviderGuidance({ ...hosted, keyStatus: "present" })).toBe(false);
		// The bare-Linux default is openrouter auto:free; a live Ollama alone
		// does not make it runnable, so the card stays until /provider ollama.
		expect(needsProviderGuidance({ ...hosted, liveLocal: 1, keyStatus: "missing" })).toBe(true);
	});

	test("agent init found the local provider unreachable: show, even before the probe lands", () => {
		const unreachable = "Ollama is not reachable.";
		expect(needsProviderGuidance({ ...base, checked: false, unreachable })).toBe(true);
		// apfel answering the status probe does not make Ollama runnable.
		expect(needsProviderGuidance({ ...base, liveLocal: 1, unreachable })).toBe(true);
		expect(needsProviderGuidance({ ...base, liveLocal: 1, unreachable: null })).toBe(false);
	});

	test("provider needing no key and no engine (host CLI): never show", () => {
		expect(needsProviderGuidance({ ...base, provider: "host-cli-primary" })).toBe(false);
	});
});

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
	test("says it once, keeps a timeout or HTTP detail", () => {
		expect(unreachableLine("Ollama", "not reachable")).toBe("Ollama is not reachable.");
		expect(unreachableLine("LM Studio", "no answer within 3s")).toBe(
			"LM Studio did not answer (no answer within 3s).",
		);
		expect(unreachableLine("Ollama", "http 500")).toBe("Ollama did not answer (http 500).");
	});
});
