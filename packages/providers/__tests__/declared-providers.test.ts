/**
 * User-declared providers (issue #2882).
 *
 * The provider set was closed at four layers: a compiled type union, the
 * `setActiveProvider` guard, `listProviders()` reading the compiled table, and
 * the client dispatch switch. A user could not point 8gent-code at a local
 * endpoint we did not anticipate without editing TypeScript, which contradicts
 * "free and local by default".
 *
 * These tests hold the seam open. The live ones dispatch against the Ollama
 * running on this host - a mocked endpoint would prove the parser works and
 * nothing about whether a declared provider actually answers.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	PROVIDER_NAMES,
	ProviderManager,
	discoverModelsAt,
	modelsUrlFor,
	normalizeDeclaredProvider,
	parseDeclaredProviders,
} from "../index";

/**
 * Ollama the live tests dispatch against. Defaults to this host; point
 * `DECLARED_TEST_BASE_URL` at another box to run the same tests there. Skipped
 * when nothing answers.
 */
const LOCAL_OLLAMA = process.env.DECLARED_TEST_BASE_URL || "http://127.0.0.1:11434";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-declared-"));

/** Write a providers.json and return a manager bound to it. */
function managerWith(settings: Record<string, unknown>): ProviderManager {
	const file = path.join(tmpDir, `providers-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify(settings, null, 2));
	return new ProviderManager(file);
}

/**
 * Probe Ollama at module scope, not in `beforeAll`. `it.skipIf` is evaluated
 * when the test is REGISTERED, which happens before any hook runs - a probe in
 * `beforeAll` leaves the flag false and skips every live test silently, which
 * looks exactly like a green run.
 */
const [live, liveModel] = await (async (): Promise<[boolean, string]> => {
	try {
		const res = await fetch(`${LOCAL_OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return [false, ""];
		const tags = (await res.json()) as { models?: { name?: string }[] };
		const names = (tags.models ?? []).map((m) => m.name ?? "").filter(Boolean);
		// Smallest known-good instruct model on this box; fall back to whatever is
		// installed so the live tests still mean something on another host.
		const model = names.find((n) => n.startsWith("llama3.2:3b")) || names[0] || "";
		return [model.length > 0, model];
	} catch {
		return [false, ""];
	}
})();

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("declaring a provider in providers.json", () => {
	const declaration = {
		activeProvider: "8gent",
		activeModel: "eight-1.0-q3:14b",
		providers: {
			forge: {
				displayName: "Forge (declared)",
				baseUrl: LOCAL_OLLAMA,
				compat: "ollama",
				defaultModel: "llama3.2:3b",
				models: ["llama3.2:3b"],
			},
		},
	};

	it("is selectable without a compiled-code change", () => {
		const pm = managerWith(declaration);
		expect(() => pm.setActiveProvider("forge")).not.toThrow();
		expect(pm.getActiveProvider().baseUrl).toBe(LOCAL_OLLAMA);
		expect(pm.getActiveModel()).toBe("llama3.2:3b");
	});

	it("is enumerated by listProviders() alongside the built-ins", () => {
		const pm = managerWith(declaration);
		const names = pm.listProviders().map((p) => p.name);
		expect(names).toContain("forge");
		// Enumeration must ADD, never replace: every compiled provider is still
		// listed, which is what the /settings and /model pickers read.
		for (const builtin of PROVIDER_NAMES) {
			expect(names).toContain(builtin);
		}
	});

	it("keeps the runtime guard closed against genuinely unknown names", () => {
		const pm = managerWith(declaration);
		expect(() => pm.setActiveProvider("not-a-provider")).toThrow(/Unknown provider/);
	});

	it("rejects a declaration with no baseUrl - there is nothing to route to", () => {
		const pm = managerWith({
			providers: { halfDeclared: { displayName: "No endpoint" } },
		});
		expect(pm.listProviders().map((p) => p.name)).not.toContain("halfDeclared");
		expect(() => pm.setActiveProvider("halfDeclared")).toThrow(/Unknown provider/);
	});

	it("says so when it ignores a declaration, rather than dropping it in silence", () => {
		// A typo'd `baseurl` key made the declaration vanish with no output, and
		// the user's next symptom was "Unknown provider" for a name sitting in
		// their own file.
		const warnings: string[] = [];
		const declared = parseDeclaredProviders(
			{ typo: { displayName: "oops" } as never, good: { baseUrl: "http://127.0.0.1:1234/v1" } },
			new Set(["ollama"]),
			(m) => warnings.push(m),
		);
		expect(Object.keys(declared)).toEqual(["good"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("typo");
		expect(warnings[0]).toContain("baseUrl");
	});

	it("rejects a declaration whose baseUrl is not an http(s) URL", () => {
		expect(normalizeDeclaredProvider("bad", { baseUrl: "not a url" })).toBeNull();
		expect(normalizeDeclaredProvider("bad", { baseUrl: "   " })).toBeNull();
		// A declared base URL becomes a fetch target, so the scheme is checked
		// rather than left to whatever `new URL` happens to parse.
		expect(normalizeDeclaredProvider("bad", { baseUrl: "file:///etc/passwd" })).toBeNull();
		expect(normalizeDeclaredProvider("bad", { baseUrl: "data:text/plain,x" })).toBeNull();
		expect(
			normalizeDeclaredProvider("ok", { baseUrl: "https://api.example.test/v1" }),
		).not.toBeNull();
	});

	it("defaults compat to OpenAI-compatible and marks the config declared", () => {
		const config = normalizeDeclaredProvider("plain", { baseUrl: "http://127.0.0.1:9999/v1" });
		expect(config?.compat).toBe("openai");
		expect(config?.declared).toBe(true);
		// Declaring it IS the opt-in; an explicit false still turns it off.
		expect(config?.enabled).toBe(true);
		expect(
			normalizeDeclaredProvider("off", { baseUrl: "http://x.test", enabled: false })?.enabled,
		).toBe(false);
	});

	it("sanitizes fields a hand-edited providers.json can get wrong", () => {
		const config = normalizeDeclaredProvider("messy", {
			baseUrl: "http://127.0.0.1:9999/v1",
			compat: "sideways" as never,
			models: ["ok", 7 as never],
			supportedThinkingLevels: ["high", "sideways" as never],
		});
		// An unrecognised compat falls back to OpenAI rather than dispatching
		// nowhere, and a bogus thinking level is dropped rather than forwarded to
		// the endpoint as a reasoning_effort it cannot parse.
		expect(config?.compat).toBe("openai");
		expect(config?.models).toEqual(["ok"]);
		expect(config?.supportedThinkingLevels).toEqual(["high"]);
	});

	it("cannot be re-opened by a bogus field surviving the settings merge", () => {
		// getProvider() re-normalizes on READ, so a bad value in the user's entry
		// is neutralized every time it is read and can never reach a dispatch.
		const pm = managerWith({
			providers: { messy: { baseUrl: "http://127.0.0.1:9999/v1", compat: "sideways" } },
		});
		expect(pm.getProvider("messy").compat).toBe("openai");
		expect(pm.compatFor(pm.getProvider("messy"))).toBe("openai");
	});

	it("never destroys a field the user typed", () => {
		// Normalization happens on READ; the declaration is never folded back over
		// the user's entry at load. Folding meant an unrelated command - /model,
		// /provider key - rewrote a hand-written 3-key entry into a full config
		// and silently dropped anything we do not model. That is user-created
		// content and destroying it is not ours to do.
		const file = path.join(tmpDir, `roundtrip-${Math.random().toString(36).slice(2)}.json`);
		const entry = {
			baseUrl: LOCAL_OLLAMA,
			compat: "ollama",
			note: "my home box",
			"x-future-key": { nested: true },
		};
		fs.writeFileSync(file, JSON.stringify({ providers: { myrig: entry } }, null, 2));

		const pm = new ProviderManager(file);
		pm.setActiveModel("llama3.2:3b");
		pm.setActiveProvider("myrig");

		const saved = JSON.parse(fs.readFileSync(file, "utf-8")).providers.myrig;
		expect(saved.note).toBe("my home box");
		expect(saved["x-future-key"]).toEqual({ nested: true });
		// Nothing we were not asked to add was added.
		expect(Object.keys(saved).sort()).toEqual(["baseUrl", "compat", "note", "x-future-key"]);
		// And the provider is still fully usable.
		expect(pm.getProvider("myrig").displayName).toBe("myrig");
		expect(pm.compatFor(pm.getProvider("myrig"))).toBe("ollama");
	});

	it("keeps an unknown key while still neutralizing a bogus one", () => {
		const file = path.join(tmpDir, `mixed-${Math.random().toString(36).slice(2)}.json`);
		fs.writeFileSync(
			file,
			JSON.stringify({
				providers: {
					messy: { baseUrl: "http://127.0.0.1:9999/v1", compat: "sideways", note: "keep me" },
				},
			}),
		);
		const pm = new ProviderManager(file);
		expect(pm.getProvider("messy").compat).toBe("openai");
		pm.setActiveModel("x");
		const saved = JSON.parse(fs.readFileSync(file, "utf-8")).providers.messy;
		// Neutralized on read, not "corrected" in the user's file behind their back.
		expect(saved.note).toBe("keep me");
		expect(saved.compat).toBe("sideways");
	});
});

describe("built-in providers are unchanged (regression)", () => {
	it("keeps compiled defaults when providers.json declares nothing", () => {
		const pm = managerWith({ providers: {} });
		expect(pm.getProvider("ollama").baseUrl).toBe("http://localhost:11434");
		expect(pm.getProvider("anthropic").baseUrl).toBe("https://api.anthropic.com/v1");
		expect(pm.getProvider("apfel").apiKeyEnv).toBe("");
		expect(pm.getProvider("openrouter").apiKeyEnv.length).toBeGreaterThan(0);
		expect(pm.listProviders().length).toBeGreaterThanOrEqual(PROVIDER_NAMES.length);
	});

	it("does not let a declaration shadow a built-in", () => {
		// An entry named after a compiled provider is what it always was: a
		// partial override. It must not become a declaration and drop the rest
		// of the compiled config.
		const pm = managerWith({
			providers: { ollama: { baseUrl: "http://127.0.0.1:31337", compat: "openai" } },
		});
		const ollama = pm.getProvider("ollama");
		expect(ollama.baseUrl).toBe("http://127.0.0.1:31337");
		expect(ollama.displayName).toBe("Ollama (Local)");
		expect(ollama.declared).toBeUndefined();
	});

	it("routes built-ins on their existing wire shapes", () => {
		const pm = managerWith({ providers: {} });
		expect(pm.compatFor(pm.getProvider("ollama"))).toBe("ollama");
		// 8gent fell through to the OpenAI-compatible branch of the old name
		// switch and must keep doing so. It disagrees with runtimeForProvider(),
		// which maps 8gent to the ollama runtime - a pre-existing divergence
		// between the two stacks, out of scope here.
		expect(pm.compatFor(pm.getProvider("8gent"))).toBe("openai");
		expect(pm.compatFor(pm.getProvider("anthropic"))).toBe("anthropic");
		expect(pm.compatFor(pm.getProvider("openrouter"))).toBe("openai");
		expect(pm.compatFor(pm.getProvider("groq"))).toBe("openai");
	});
});

describe("model discovery", () => {
	it("targets the right endpoint per wire shape", () => {
		expect(modelsUrlFor("http://h:1/v1", "openai")).toBe("http://h:1/v1/models");
		expect(modelsUrlFor("http://h:1/", "ollama")).toBe("http://h:1/api/tags");
		expect(modelsUrlFor("http://h:1", "anthropic")).toBe("http://h:1/models");
	});

	it.skipIf(!live)("lists models from a real Ollama over the native shape", async () => {
		const models = await discoverModelsAt(LOCAL_OLLAMA, "ollama");
		expect(models.length).toBeGreaterThan(0);
		expect(models).toContain(liveModel);
	});

	it.skipIf(!live)("lists models from a real Ollama over the OpenAI shape", async () => {
		const models = await discoverModelsAt(`${LOCAL_OLLAMA}/v1`, "openai");
		expect(models.length).toBeGreaterThan(0);
		expect(models).toContain(liveModel);
	});

	it.skipIf(!live)("fills a declared provider's model list and persists it", async () => {
		const pm = managerWith({
			providers: { forge: { baseUrl: LOCAL_OLLAMA, compat: "ollama" } },
		});
		const models = await pm.discoverModels("forge");
		expect(models).toContain(liveModel);
		// A declaration that named no defaultModel is usable after discovery.
		expect(pm.getProvider("forge").defaultModel).toBe(models[0]);
		expect(() => pm.setActiveProvider("forge")).not.toThrow();
	});
});

describe("a declared provider reaches a real endpoint", () => {
	it.skipIf(!live)(
		"returns a real completion over the native Ollama shape",
		async () => {
			const pm = managerWith({
				activeProvider: "forge",
				activeModel: liveModel,
				providers: {
					forge: { baseUrl: LOCAL_OLLAMA, compat: "ollama", defaultModel: liveModel },
				},
			});
			const res = await pm.chat({
				messages: [{ role: "user", content: "Reply with the single word: pong" }],
				maxTokens: 16,
			});
			expect(res.content.length).toBeGreaterThan(0);
			expect(res.provider).toBe("forge");
			expect(res.model).toBe(liveModel);
		},
		120_000,
	);

	it.skipIf(!live)(
		"returns a real completion over the OpenAI-compatible shape",
		async () => {
			const pm = managerWith({
				activeProvider: "forge-oai",
				activeModel: liveModel,
				providers: {
					// Same server, /v1 prefix, OpenAI Chat Completions shape. This is the
					// path any llama.cpp / vLLM / LM Studio clone lands on.
					"forge-oai": {
						baseUrl: `${LOCAL_OLLAMA}/v1`,
						compat: "openai",
						defaultModel: liveModel,
					},
				},
			});
			const res = await pm.chat({
				messages: [{ role: "user", content: "Reply with the single word: pong" }],
				maxTokens: 16,
			});
			expect(res.content.length).toBeGreaterThan(0);
			expect(res.provider).toBe("forge-oai");
		},
		120_000,
	);
});
