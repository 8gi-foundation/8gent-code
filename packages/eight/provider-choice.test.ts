/**
 * #4362 / #4363: `8gent chat` and `8gent run` honour the provider and model
 * saved by onboarding. Order: --provider flag > saved choice > adaptive router.
 * A saved provider is skipped only when unreachable, and the skip is worded.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import {
	type ProviderChoiceDeps,
	providerRouteNotice,
	readSavedProviderChoice,
	resolveChatChoice,
	resolveProviderChoice,
	shouldShowRouteNotice,
} from "./run";

function deps(over: Partial<ProviderChoiceDeps> = {}): ProviderChoiceDeps {
	return {
		saved: { provider: "lmstudio", model: "gemma-4-26b-a4b-it" },
		reachable: async () => true,
		ollamaUp: async () => true,
		ollamaModel: async () => "8gate:latest",
		...over,
	};
}

describe("resolveProviderChoice", () => {
	test("a saved choice beats the default router, model included", async () => {
		const c = await resolveProviderChoice({}, deps());
		expect(c).toEqual({ provider: "lmstudio", model: "gemma-4-26b-a4b-it", source: "saved" });
	});

	test("--provider and --model beat the saved choice", async () => {
		const c = await resolveProviderChoice({ provider: "ollama", model: "qwen3:14b" }, deps());
		expect(c).toMatchObject({ provider: "ollama", model: "qwen3:14b", source: "flag" });
	});

	test("--provider alone takes the saved model only when it is the same provider", async () => {
		const same = await resolveProviderChoice({ provider: "lmstudio" }, deps());
		expect(same.model).toBe("gemma-4-26b-a4b-it");
		const other = await resolveProviderChoice({ provider: "ollama" }, deps());
		expect(other.model).toBe("8gate:latest");
	});

	test("nothing saved: the router picks Ollama when it answers, else OpenRouter", async () => {
		const up = await resolveProviderChoice({}, deps({ saved: undefined }));
		expect(up).toMatchObject({ provider: "ollama", model: "8gate:latest", source: "router" });
		expect(up.notice).toBeUndefined();
		const down = await resolveProviderChoice(
			{},
			deps({ saved: undefined, ollamaUp: async () => false }),
		);
		expect(down.provider).toBe("openrouter");
		const chat = await resolveProviderChoice(
			{ routerFallback: "ollama" },
			deps({ saved: undefined, ollamaUp: async () => false }),
		);
		expect(chat.provider).toBe("ollama");
	});

	test("an unreachable saved provider falls back and says so", async () => {
		const c = await resolveProviderChoice({}, deps({ reachable: async () => false }));
		expect(c.provider).toBe("ollama");
		expect(c.source).toBe("router");
		expect(c.notice).toBe("LM Studio not reachable, using Ollama 8gate:latest");
	});

	test("the saved provider is probed by name, not Ollama", async () => {
		const probed: string[] = [];
		await resolveProviderChoice(
			{},
			deps({
				reachable: async (p) => {
					probed.push(p);
					return true;
				},
			}),
		);
		expect(probed).toEqual(["lmstudio"]);
	});
});

describe("readSavedProviderChoice", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmRetry(d);
	});
	const homeWith = (body: unknown | undefined): string => {
		const home = mkdtempSync(join(tmpdir(), "choice4362-"));
		dirs.push(home);
		mkdirSync(join(home, ".8gent"), { recursive: true });
		if (body !== undefined) {
			writeFileSync(join(home, ".8gent", "providers.json"), JSON.stringify(body));
		}
		return home;
	};

	test("reads what onboarding wrote", () => {
		const home = homeWith({ activeProvider: "lmstudio", activeModel: "gemma-4-26b-a4b-it" });
		expect(readSavedProviderChoice({}, home)).toEqual({
			provider: "lmstudio",
			model: "gemma-4-26b-a4b-it",
		});
	});

	test("no file, no activeProvider, or a broken file is no choice", () => {
		expect(readSavedProviderChoice({}, homeWith(undefined))).toBeUndefined();
		expect(readSavedProviderChoice({}, homeWith({ providers: {} }))).toBeUndefined();
		const broken = homeWith(undefined);
		writeFileSync(join(broken, ".8gent", "providers.json"), "{nope");
		expect(readSavedProviderChoice({}, broken)).toBeUndefined();
	});

	test("EIGHT_PROVIDERS_SETTINGS_PATH wins over the home directory", () => {
		const home = homeWith({ activeProvider: "ollama" });
		const alt = join(home, "alt.json");
		writeFileSync(alt, JSON.stringify({ activeProvider: "openrouter" }));
		expect(readSavedProviderChoice({ EIGHT_PROVIDERS_SETTINGS_PATH: alt }, home)?.provider).toBe(
			"openrouter",
		);
	});
});

describe("providerRouteNotice", () => {
	test("did not answer (no reason)", () => {
		expect(providerRouteNotice("gemma-4-26b-a4b-it", "ollama", "8gate:latest")).toBe(
			"gemma-4-26b-a4b-it did not answer, using Ollama 8gate:latest.",
		);
	});

	test("capability switch is worded as a step-level choice", () => {
		expect(providerRouteNotice("gemma-4", "lmstudio", "ornith-1.0-9b", "capability")).toBe(
			"gemma-4 cannot call tools, using LM Studio ornith-1.0-9b for this step.",
		);
	});

	test("a missing model says it is not installed", () => {
		expect(providerRouteNotice("qwen3:14b", "ollama", "8gate:latest", "missing")).toBe(
			"qwen3:14b is not installed, using Ollama 8gate:latest.",
		);
	});
});

describe("shouldShowRouteNotice", () => {
	test("A, B, A prints A and B once each: two lines, not three", () => {
		const shown = new Set<string>();
		const printed = ["A", "B", "A"].filter((k) => shouldShowRouteNotice(shown, k));
		expect(printed).toEqual(["A", "B"]);
	});

	test("the same route with a different reason is a different notice", () => {
		const shown = new Set<string>();
		expect(shouldShowRouteNotice(shown, "a>b|missing")).toBe(true);
		expect(shouldShowRouteNotice(shown, "a>b|capability")).toBe(true);
	});
});

describe("resolveChatChoice", () => {
	test("a saved provider chat cannot run falls back to the router with the reason", async () => {
		const c = await resolveChatChoice({}, deps({ saved: { provider: "groq", model: "llama" } }));
		expect(c.provider).toBe("ollama");
		expect(c.source).toBe("router");
		expect(c.notice).toBe("groq is not a chat provider, using Ollama 8gate:latest");
	});

	test("a saved chat runtime is honoured, and an unreachable one keeps its own notice", async () => {
		expect((await resolveChatChoice({}, deps())).provider).toBe("lmstudio");
		const down = await resolveChatChoice({}, deps({ reachable: async () => false }));
		expect(down.notice).toBe("LM Studio not reachable, using Ollama 8gate:latest");
	});
});
