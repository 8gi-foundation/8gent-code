import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../ai";
import { providerConfigForRole, smallRoleConfigFor } from "./role-model";

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

describe("smallRoleConfigFor: the main call's gates", () => {
	const roles = { small: { provider: "openrouter", model: "tiny:free" } };
	const keyed = keys({ openrouter: "sk-or" });
	const runsLocal = (c: ProviderConfig) => c.name === "ollama";
	const gates = (policy: "local-only" | "local-first" | "cloud-first", paths: string[] = []) => ({
		policy: { policy, localHosts: [] },
		recentFilePaths: paths,
		runsLocal,
	});
	const saved = { hosted: process.env.EIGHT_ALLOW_HOSTED, allow: process.env.EIGHT_PROVIDERS_ALLOW };
	beforeEach(() => {
		process.env.EIGHT_ALLOW_HOSTED = "1";
		Reflect.deleteProperty(process.env, "EIGHT_PROVIDERS_ALLOW");
	});
	afterEach(() => {
		for (const [k, v] of [
			["EIGHT_ALLOW_HOSTED", saved.hosted],
			["EIGHT_PROVIDERS_ALLOW", saved.allow],
		] as const) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
	});

	test("local-first, allowed, keyed: the hosted small role", () => {
		expect(smallRoleConfigFor(roles, session, keyed, gates("local-first")).name).toBe("openrouter");
	});

	test("local-only: the session, never the hosted small role", () => {
		expect(smallRoleConfigFor(roles, session, keyed, gates("local-only"))).toBe(session);
	});

	test("a sensitive read (.env): the session, never the hosted small role", () => {
		expect(smallRoleConfigFor(roles, session, keyed, gates("cloud-first", ["/r/.env"]))).toBe(session);
	});

	test("hosted not opted in (EIGHT_ALLOW_HOSTED unset): the session", () => {
		Reflect.deleteProperty(process.env, "EIGHT_ALLOW_HOSTED");
		expect(smallRoleConfigFor(roles, session, keyed, gates("cloud-first"))).toBe(session);
	});

	test("EIGHT_PROVIDERS_ALLOW that does not name it: the session", () => {
		process.env.EIGHT_PROVIDERS_ALLOW = "ollama,groq";
		expect(smallRoleConfigFor(roles, session, keyed, gates("cloud-first"))).toBe(session);
	});

	test("a hosted session after a .env read: held to the local model, as the main call is", () => {
		const hosted: ProviderConfig = { name: "openrouter", model: "big", apiKey: "sk-or" };
		const c = smallRoleConfigFor(undefined, hosted, keyed, gates("local-first", ["/r/.env"]));
		expect(c.name).toBe("ollama");
		expect(c.apiKey).toBeUndefined();
		expect(c.baseURL).toBeUndefined();
	});
});
