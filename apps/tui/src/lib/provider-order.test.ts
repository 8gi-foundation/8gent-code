import { describe, expect, test } from "bun:test";
import type { ProviderOption } from "../components/select-input.js";
import { orderProviders, providerRowNote, statusFirstLine } from "./provider-order.js";

const reg: ProviderOption[] = [
	{ name: "8gent", displayName: "8gent", hasApiKey: false, needsKey: false, enabled: true },
	{
		name: "ollama",
		displayName: "Ollama (Local)",
		hasApiKey: false,
		needsKey: false,
		enabled: true,
	},
	{ name: "lmstudio", displayName: "LM Studio", hasApiKey: false, needsKey: false, enabled: true },
	{
		name: "openrouter",
		displayName: "OpenRouter",
		hasApiKey: false,
		needsKey: true,
		enabled: false,
	},
	{ name: "groq", displayName: "Groq", hasApiKey: false, needsKey: true, enabled: false },
	{ name: "minimax", displayName: "MiniMax", hasApiKey: true, needsKey: true, enabled: true },
];

describe("orderProviders (#4720)", () => {
	test("a keyed provider is first when no local engine answers; unavailable ones are last", () => {
		const o = orderProviders(reg, { ollama: false, lmstudio: false });
		expect(o[0].name).toBe("minimax");
		expect(o.slice(-2).map((p) => p.name)).toEqual(["openrouter", "groq"]);
		expect(o.map((p) => p.availability)).toEqual([
			"runnable",
			"not-reachable",
			"not-reachable",
			"not-reachable",
			"unavailable",
			"unavailable",
		]);
	});
	test("an engine the probe has not reported on is not treated as down", () => {
		const o = orderProviders(reg, {});
		expect(o.find((p) => p.name === "ollama")?.availability).toBe("runnable");
	});
	test("order is stable inside each group", () => {
		const o = orderProviders(reg, { ollama: true, lmstudio: false });
		expect(o.map((p) => p.name)).toEqual([
			"8gent",
			"ollama",
			"minimax",
			"lmstudio",
			"openrouter",
			"groq",
		]);
	});
});

describe("providerRowNote", () => {
	const o = orderProviders(reg, { ollama: false });
	const row = (n: string) => o.find((p) => p.name === n)!;
	test("the active row says so when it is not reachable", () => {
		expect(providerRowNote(row("ollama"), true)).toBe("active, not reachable");
		expect(providerRowNote(row("minimax"), true)).toBe("Currently active");
	});
	test("the other rows say why they are where they are", () => {
		expect(providerRowNote(row("ollama"), false)).toBe("Not reachable right now");
		expect(providerRowNote(row("minimax"), false)).toBe("API key configured");
		expect(providerRowNote(row("groq"), false)).toBe("No API key (requires setup)");
	});
});

describe("statusFirstLine", () => {
	const base = { provider: "minimax", label: "MiniMax", model: "m-1" };
	test("ready reads reachable", () => {
		expect(statusFirstLine({ ...base, readiness: { state: "ready", reason: "" } })).toBe(
			"Provider: MiniMax (minimax), model m-1, reachable",
		);
	});
	test("not ready names the reason, and a missing key is not called unreachable", () => {
		expect(
			statusFirstLine({
				provider: "ollama",
				label: "Ollama",
				model: "",
				readiness: { state: "none", reason: "Ollama is not answering." },
			}),
		).toBe(
			"Provider: Ollama (ollama), model no model yet, not reachable (Ollama is not answering.)",
		);
		expect(
			statusFirstLine({
				...base,
				readiness: { state: "none", reason: "minimax needs an API key." },
			}),
		).toContain("not ready (minimax needs an API key.)");
	});
	test("checking is said as checking", () => {
		expect(statusFirstLine({ ...base, readiness: { state: "checking", reason: "x" } })).toContain(
			", checking",
		);
	});
});
