/**
 * apfel port pin (#2898).
 *
 * The settings default shipped apfel at :11500, where nothing listens.
 * app.tsx exports that default as APFEL_BASE_URL, which then overrode the
 * correct :11435 in packages/providers/index.ts. The TUI health probe carried
 * the same wrong fallback, so the status bar reported apfel dead while it was up.
 *
 * These tests keep all three in agreement on 11435, and keep all three off
 * 11434 (Ollama's port, which answers instead of refusing).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getProviderManager } from "../../../../packages/providers/index.js";
import { DEFAULT_SETTINGS } from "../../../../packages/settings/defaults.js";
import { probeProviders } from "./provider-health.js";

const realFetch = globalThis.fetch;
const savedApfel = process.env.APFEL_BASE_URL;

afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedApfel === undefined) delete process.env.APFEL_BASE_URL;
	else process.env.APFEL_BASE_URL = savedApfel;
});

describe("apfel default port", () => {
	test("settings default points at 11435, not 11500 or Ollama's 11434", () => {
		const url = DEFAULT_SETTINGS.providers.apfel.baseURL;
		expect(url).toContain(":11435/");
		expect(url).not.toContain("11500");
		expect(url).not.toContain("11434");
	});

	test("settings default agrees with the provider registry's port", () => {
		const registryUrl = getProviderManager().getProvider("apfel").baseUrl;
		const port = (u: string) => new URL(u).port;
		expect(port(DEFAULT_SETTINGS.providers.apfel.baseURL)).toBe(port(registryUrl));
	});

	test("health probe falls back to 11435 when APFEL_BASE_URL is unset", async () => {
		delete process.env.APFEL_BASE_URL;
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			seen.push(String(input instanceof Request ? input.url : input));
			return new Response("{}", { status: 503 });
		}) as typeof fetch;

		await probeProviders();

		const apfelProbes = seen.filter((u) => u.includes("/health") || u.includes("/v1/models"));
		expect(apfelProbes.some((u) => u.startsWith("http://127.0.0.1:11435/"))).toBe(true);
		expect(seen.some((u) => u.includes("11500"))).toBe(false);
	});
});

/**
 * The Ollama probes resolve the host like the rest of the app: OLLAMA_BASE_URL
 * first, then OLLAMA_HOST, normalised. Both used to read the raw OLLAMA_HOST,
 * so a bare "host:port" (what the ollama CLI takes) became an invalid URL and
 * OLLAMA_BASE_URL was ignored.
 */
describe("ollama host resolution in the TUI probes", () => {
	const saved = { host: process.env.OLLAMA_HOST, base: process.env.OLLAMA_BASE_URL };
	afterEach(() => {
		for (const [k, v] of [
			["OLLAMA_HOST", saved.host],
			["OLLAMA_BASE_URL", saved.base],
		] as const) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
	});
	const recordFetch = (): string[] => {
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			seen.push(String(input instanceof Request ? input.url : input));
			return new Response(JSON.stringify({ models: [{ name: "m" }] }), { status: 200 });
		}) as typeof fetch;
		return seen;
	};

	test("provider health: a bare host:port OLLAMA_HOST is probed as a real URL", async () => {
		Reflect.deleteProperty(process.env, "OLLAMA_BASE_URL");
		process.env.OLLAMA_HOST = "10.0.0.5:11434";
		const seen = recordFetch();
		await probeProviders();
		expect(seen).toContain("http://10.0.0.5:11434/api/tags");
	});

	test("provider health: OLLAMA_BASE_URL wins over OLLAMA_HOST", async () => {
		process.env.OLLAMA_BASE_URL = "http://gpu:21434";
		process.env.OLLAMA_HOST = "other:1";
		const seen = recordFetch();
		await probeProviders();
		expect(seen).toContain("http://gpu:21434/api/tags");
		expect(seen.some((u) => u.includes("other:1"))).toBe(false);
	});

	test("setup provider check: same resolution for the model list", async () => {
		const { fetchProviderModels } = await import("../screens/OnboardingScreen.js");
		process.env.OLLAMA_BASE_URL = "http://gpu:21434";
		process.env.OLLAMA_HOST = "other:1";
		let seen = recordFetch();
		expect(await fetchProviderModels("ollama")).toEqual(["m"]);
		expect(seen).toEqual(["http://gpu:21434/api/tags"]);
		Reflect.deleteProperty(process.env, "OLLAMA_BASE_URL");
		process.env.OLLAMA_HOST = "10.0.0.5:11434";
		seen = recordFetch();
		await fetchProviderModels("ollama");
		expect(seen).toEqual(["http://10.0.0.5:11434/api/tags"]);
	});
});
