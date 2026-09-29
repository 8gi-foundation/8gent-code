/**
 * Client dispatch for user-declared providers (issue #2882).
 *
 * `runtimeForProvider` was a closed switch over compiled names, so the second
 * of the two provider stacks stayed shut even after the registry opened. It now
 * falls through to the loaded declaration and routes on its `compat`.
 *
 * The live test dispatches through `createClient` to the Ollama on this host:
 * the seam is only open if a real client, built from a declared name, gets a
 * real completion back.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProviderManager, resetProviderManager } from "../../providers";
import { OllamaClient, OpenRouterClient, createClient, runtimeForProvider } from "./index";

/**
 * Ollama to dispatch against. Defaults to this host; point
 * `DECLARED_TEST_BASE_URL` at another box (a tunnelled second machine, a
 * llama.cpp server) to run the same live tests there. Skipped when nothing
 * answers.
 */
const LOCAL_OLLAMA = process.env.DECLARED_TEST_BASE_URL || "http://127.0.0.1:11434";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-dispatch-"));
const originalPath = process.env.EIGHT_PROVIDERS_SETTINGS_PATH;

/**
 * Point the provider singleton at a throwaway providers.json. `runtimeForProvider`
 * reads the singleton, so the declaration has to be visible there and not in the
 * user's real ~/.8gent/providers.json.
 */
function declareProviders(providers: Record<string, unknown>): void {
	const file = path.join(tmpDir, `providers-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ providers }, null, 2));
	process.env.EIGHT_PROVIDERS_SETTINGS_PATH = file;
	resetProviderManager();
}

/** Probe at module scope: `skipIf` is evaluated before any hook runs. */
const [live, liveModel] = await (async (): Promise<[boolean, string]> => {
	try {
		const res = await fetch(`${LOCAL_OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return [false, ""];
		const tags = (await res.json()) as { models?: { name?: string }[] };
		const names = (tags.models ?? []).map((m) => m.name ?? "").filter(Boolean);
		const model = names.find((n) => n.startsWith("llama3.2:3b")) || names[0] || "";
		return [model.length > 0, model];
	} catch {
		return [false, ""];
	}
})();

afterEach(() => {
	if (originalPath === undefined)
		Reflect.deleteProperty(process.env, "EIGHT_PROVIDERS_SETTINGS_PATH");
	else process.env.EIGHT_PROVIDERS_SETTINGS_PATH = originalPath;
	resetProviderManager();
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runtimeForProvider with declared providers", () => {
	test("routes a declared provider on its compat, not its name", () => {
		declareProviders({
			"forge-oai": { baseUrl: `${LOCAL_OLLAMA}/v1`, compat: "openai" },
			"forge-native": { baseUrl: LOCAL_OLLAMA, compat: "ollama" },
			"proxy-claude": { baseUrl: "http://127.0.0.1:8787", compat: "anthropic" },
			"forge-default": { baseUrl: `${LOCAL_OLLAMA}/v1` },
		});
		expect(runtimeForProvider("forge-oai")).toBe("openrouter");
		expect(runtimeForProvider("forge-native")).toBe("ollama");
		expect(runtimeForProvider("proxy-claude")).toBe("anthropic");
		// No compat declared means OpenAI-compatible, the common case.
		expect(runtimeForProvider("forge-default")).toBe("openrouter");
	});

	test("built-in routing is unchanged (regression)", () => {
		declareProviders({ forge: { baseUrl: LOCAL_OLLAMA, compat: "ollama" } });
		expect(runtimeForProvider("anthropic")).toBe("anthropic");
		expect(runtimeForProvider("groq")).toBe("openrouter");
		expect(runtimeForProvider("openrouter")).toBe("openrouter");
		expect(runtimeForProvider("ollama")).toBe("ollama");
		expect(runtimeForProvider("8gent")).toBe("ollama");
		expect(runtimeForProvider("lmstudio")).toBe("lmstudio");
		expect(runtimeForProvider("apfel")).toBe("apfel");
		expect(runtimeForProvider("apple-foundation")).toBe("apple-foundation");
		expect(runtimeForProvider("deepseek")).toBe("deepseek");
		// The host-CLI slots have no runtime of their own and used to land on the
		// switch's `default`. Removing that default must not change where they go.
		expect(runtimeForProvider("host-cli-primary")).toBe("ollama");
		expect(runtimeForProvider("host-cli-secondary")).toBe("ollama");
		// An unknown name still falls through to the local runtime, as before.
		expect(runtimeForProvider("nothing-declared-here")).toBe("ollama");
	});

	test("a declared base URL reaches the OpenAI-compatible client", () => {
		const client = createClient({
			runtime: "openrouter",
			model: "test",
			apiKey: "",
			baseUrl: "http://127.0.0.1:31337/v1",
		});
		expect(client).toBeInstanceOf(OpenRouterClient);
		// The client previously ignored baseUrl on this branch, which is what made
		// a declared OpenAI-compatible endpoint unreachable through this stack.
		expect((client as unknown as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:31337/v1");
	});
});

describe("PII gate applies to egress, not to on-device endpoints", () => {
	/** Stand up a one-shot OpenAI-compatible server and capture what it receives. */
	async function captureRequest(
		baseUrlFor: (port: number) => string,
	): Promise<Record<string, unknown>> {
		let received: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				received = (await req.json()) as Record<string, unknown>;
				return Response.json({
					choices: [{ message: { role: "assistant", content: "ok" } }],
				});
			},
		});
		try {
			const port = server.port ?? 0;
			const client = new OpenRouterClient("test-model", "", baseUrlFor(port));
			await client.chat([
				{ role: "user", content: "My name is James Spalding, email james@example.com" },
			]);
		} finally {
			server.stop(true);
		}
		return received;
	}

	test("a loopback baseUrl sends the real message, unpseudonymized", async () => {
		// A declared provider can point this client at a server on this machine.
		// Nothing leaves the device, so there is no egress boundary - and handing
		// a coding agent pseudonymized paths and identifiers corrupts its input.
		const sent = JSON.stringify(await captureRequest((port) => `http://127.0.0.1:${port}/v1`));
		expect(sent).toContain("james@example.com");
	}, 15_000);

	test("a non-loopback baseUrl still goes through the anonymizer", async () => {
		// Same server, reached by a name that is not loopback. isCloudProvider is
		// deliberately strict, and that fail-safe direction must not regress.
		const sent = JSON.stringify(await captureRequest((port) => `http://localtest.me:${port}/v1`));
		expect(sent).not.toContain("james@example.com");
	}, 15_000);
});

describe("a declared provider reaches a real endpoint through createClient", () => {
	test.skipIf(!live)(
		"native Ollama shape returns a real completion",
		async () => {
			declareProviders({
				forge: { baseUrl: LOCAL_OLLAMA, compat: "ollama", defaultModel: liveModel },
			});
			const cfg = getProviderManager().getProvider("forge");
			const client = createClient({
				runtime: runtimeForProvider("forge"),
				model: liveModel,
				baseUrl: cfg.baseUrl,
			});
			expect(client).toBeInstanceOf(OllamaClient);
			const res = await client.chat([
				{ role: "user", content: "Reply with the single word: pong" },
			]);
			expect(res.message.content.length).toBeGreaterThan(0);
			expect(res.model).toBe(liveModel);
		},
		120_000,
	);

	test.skipIf(!live)(
		"OpenAI-compatible shape returns a real completion",
		async () => {
			declareProviders({ "forge-oai": { baseUrl: `${LOCAL_OLLAMA}/v1`, compat: "openai" } });
			const cfg = getProviderManager().getProvider("forge-oai");
			const client = createClient({
				runtime: runtimeForProvider("forge-oai"),
				model: liveModel,
				apiKey: "",
				baseUrl: cfg.baseUrl,
			});
			expect(client).toBeInstanceOf(OpenRouterClient);
			const res = await client.chat([
				{ role: "user", content: "Reply with the single word: pong" },
			]);
			expect(res.message.content.length).toBeGreaterThan(0);
			expect(res.model).toBe(liveModel);
		},
		120_000,
	);
});
