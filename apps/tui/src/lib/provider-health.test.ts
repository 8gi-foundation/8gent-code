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
