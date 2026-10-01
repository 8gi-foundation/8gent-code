import { describe, expect, test } from "bun:test";
import {
	needsProviderGuidance,
	notReadyState,
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
		const unreachable = "Ollama at 127.0.0.1:11434 did not answer.";
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

describe("notReadyState: what the NOW strip says while no agent is ready (#3290)", () => {
	const bare = {
		checked: true,
		liveLocal: 0,
		provider: "8gent",
		keyStatus: "not-needed" as const,
		unreachable: null,
	};

	test("a ready agent needs no state", () => {
		expect(notReadyState({ ...bare, agentReady: true })).toBeNull();
	});

	test("nothing answering: NO MODEL with the probe's reason", () => {
		expect(notReadyState({ ...bare, agentReady: false })).toEqual({
			kind: "none",
			reason: "No local model is answering.",
		});
		const unreachable = "Ollama at http://127.0.0.1:11434 did not answer.";
		expect(notReadyState({ ...bare, agentReady: false, unreachable })).toEqual({
			kind: "none",
			reason: unreachable,
		});
	});

	test("a hosted provider with no key says so", () => {
		expect(
			notReadyState({ ...bare, agentReady: false, provider: "openrouter", keyStatus: "missing" }),
		).toEqual({ kind: "none", reason: "openrouter needs an API key." });
	});

	test("before the first probe lands it is checking, never NO MODEL and never ready", () => {
		expect(notReadyState({ ...bare, agentReady: false, checked: false })).toEqual({
			kind: "checking",
			reason: "looking for a model",
		});
	});
});
