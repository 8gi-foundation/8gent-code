import { describe, expect, test } from "bun:test";
import { PROVIDER_INSTALL_HINTS } from "./onboarding";

describe("onboarding provider hints (#4915)", () => {
	test("the ollama hint names the llama-server provider, not a system install", () => {
		const hint = PROVIDER_INSTALL_HINTS.ollama;
		expect(hint).not.toMatch(/brew install/i);
		expect(hint).not.toMatch(/ollama serve/i);
		expect(hint).toContain("/provider llama-server");
		expect(hint).not.toContain("/judge install");
	});

	test("the pull step for people who already run Ollama is kept", () => {
		expect(PROVIDER_INSTALL_HINTS.ollama).toContain("ollama pull");
	});
});
