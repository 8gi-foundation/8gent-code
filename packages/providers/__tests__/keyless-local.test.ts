/**
 * Keyless local providers (packages/providers/index.ts).
 *
 * apfel is an on-device HTTP service with no auth, so it declares apiKeyEnv:"".
 * The OpenAI-compatible chat path demanded a key from EVERY provider anyway and
 * threw "No API key for apfel (Apple Foundation HTTP). Set  or use /settings" -
 * an error naming no environment variable, because there is not one to name.
 * That is why 8EO was dead on apfel and looked like a model problem.
 *
 * The other half was quieter and worse: apfel's default baseUrl was 11434,
 * which is OLLAMA's port. An unconfigured apfel request was answered by Ollama,
 * which then failed on an unknown model. Verified live on 2026-08-06: 11435
 * serves apple-foundationmodel and returns 200 to a keyless request.
 */

import { describe, expect, it } from "bun:test";
import { getProviderManager } from "../index";

describe("keyless local providers", () => {
	it("does not point apfel at Ollama's port", () => {
		const apfel = getProviderManager().getProvider("apfel");
		expect(apfel.baseUrl).not.toContain("11434");
		expect(apfel.baseUrl).toContain("11435");
	});

	it("keeps apfel keyless and enabled-by-host, not key-gated", () => {
		const apfel = getProviderManager().getProvider("apfel");
		// Empty apiKeyEnv is the DECLARATION that no key exists. It is the flag
		// the auth gate now reads, so it must not drift to a placeholder.
		expect(apfel.apiKeyEnv).toBe("");
		expect(getProviderManager().getApiKey("apfel")).toBeNull();
	});

	it("still requires a key from providers that declare one", () => {
		// The fix must not become "never require a key". Cloud providers name an
		// env var, and that is exactly what keeps the gate on for them.
		for (const name of ["openai", "anthropic", "openrouter"] as const) {
			expect(getProviderManager().getProvider(name).apiKeyEnv.length).toBeGreaterThan(0);
		}
	});
});
