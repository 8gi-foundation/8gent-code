import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../ai";
import { providerConfigForRole } from "./role-model";

const session: ProviderConfig = { name: "ollama", model: "qwen3:14b", baseURL: "http://h:11434/v1" };
const keys = (have: Record<string, string>) => ({
	hasCredentials: (p: string) => p === "ollama" || p in have,
	getApiKey: (p: string) => have[p] ?? null,
});

describe("providerConfigForRole", () => {
	test("no roles: the session config, same object", () => {
		expect(providerConfigForRole("small", undefined, session, keys({}))).toBe(session);
	});

	test("small set on another provider: its model and its own key, not the session's endpoint", () => {
		const c = providerConfigForRole(
			"small",
			{ small: { provider: "openrouter", model: "tiny:free" } },
			session,
			keys({ openrouter: "sk-or" }),
		);
		expect(c).toEqual({ name: "openrouter", model: "tiny:free", apiKey: "sk-or", baseURL: undefined });
	});

	test("small set on the same provider keeps the session's endpoint", () => {
		const c = providerConfigForRole(
			"small",
			{ small: { provider: "ollama", model: "tiny:1b" } },
			session,
			keys({}),
		);
		expect(c).toEqual({ name: "ollama", model: "tiny:1b", apiKey: undefined, baseURL: session.baseURL });
	});

	test("small set but its provider has no key: falls back to the session", () => {
		const c = providerConfigForRole(
			"small",
			{ small: { provider: "openrouter", model: "tiny:free" } },
			session,
			keys({}),
		);
		expect(c).toBe(session);
	});

	test("main role does not touch small", () => {
		const roles = { small: { provider: "ollama", model: "tiny:1b" } };
		expect(providerConfigForRole("main", roles, session, keys({}))).toBe(session);
	});
});
