/**
 * One key resolver for every provider path (#4622).
 *
 * For each wired hosted provider: with its own env key set (a FAKE value), the
 * AI-SDK request (mocked fetch) goes to that provider's registry base URL with
 * bearer auth; with the key unset, the call refuses before any request and the
 * message tells the user to add the key with `8gent keys`. No provider's key is
 * ever used for another provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModel } from "../../ai/providers";
import { FileKeyBackend, resetKeyVault } from "../../secrets/key-vault";
import { getProviderManager, resetProviderManager } from "../index";
import { isHostedChatProvider, resolveProviderKey } from "../key-resolver";

let home: string;
let savedFetch: typeof fetch;
const savedEnv: Record<string, string | undefined> = {};

function allKeyEnvs(): string[] {
	return getProviderManager()
		.listProviders()
		.map((p) => p.apiKeyEnv)
		.filter(Boolean);
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "provkey-"));
	const file = new FileKeyBackend(path.join(home, "vault.enc"));
	resetKeyVault({ primary: file, file });
	for (const k of ["EIGHT_DATA_DIR", "EIGHT_PROVIDERS_SETTINGS_PATH"]) savedEnv[k] = process.env[k];
	process.env.EIGHT_DATA_DIR = home;
	Reflect.deleteProperty(process.env, "EIGHT_PROVIDERS_SETTINGS_PATH");
	resetProviderManager();
	for (const k of allKeyEnvs()) {
		savedEnv[k] = process.env[k];
		Reflect.deleteProperty(process.env, k);
	}
	savedFetch = globalThis.fetch;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	globalThis.fetch = savedFetch;
	resetKeyVault();
	resetProviderManager();
	fs.rmSync(home, { recursive: true, force: true });
});

interface Seen {
	url: string;
	auth: string | null;
}

function mockFetch(seen: Seen[]): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		seen.push({ url: String(input), auth: headers.get("authorization") });
		return new Response(
			JSON.stringify({
				id: "x",
				choices: [
					{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
}

async function call(name: string): Promise<void> {
	const model = createModel({ name, model: "test-model" }) as unknown as {
		doGenerate: (o: unknown) => Promise<unknown>;
	};
	await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
}

const hosted = (): string[] =>
	getProviderManager()
		.listProviders()
		.map((p) => p.name as string)
		.filter(isHostedChatProvider);

describe("registry-driven key resolution", () => {
	test("minimax is among the wired hosted providers", () => {
		expect(hosted()).toContain("minimax");
		expect(hosted().length).toBeGreaterThanOrEqual(5);
	});

	test("key set: the request carries that provider's key to that provider's base URL", async () => {
		for (const name of hosted()) {
			const cfg = getProviderManager().getProvider(name);
			const fake = `fake-${name}-key-not-real`;
			process.env[cfg.apiKeyEnv] = fake;
			const seen: Seen[] = [];
			mockFetch(seen);
			await call(name);
			Reflect.deleteProperty(process.env, cfg.apiKeyEnv);
			expect(seen.length, name).toBe(1);
			expect(seen[0].url.startsWith(cfg.baseUrl), `${name}: ${seen[0].url}`).toBe(true);
			expect(seen[0].auth, name).toBe(`Bearer ${fake}`);
		}
	});

	test("key unset: refused before any request, with a plain 'add your key' message", async () => {
		for (const name of hosted()) {
			const seen: Seen[] = [];
			mockFetch(seen);
			let message = "";
			try {
				await call(name);
			} catch (e) {
				message = e instanceof Error ? e.message : String(e);
			}
			expect(seen.length, name).toBe(0);
			expect(message, name).toContain(`No API key for ${name}`);
			expect(message, name).toContain("8gent keys");
			expect(message, name).toContain(getProviderManager().getProvider(name).apiKeyEnv);
		}
	});

	test("no cross-provider fallback: another provider's key never reaches this one", async () => {
		process.env.OPENROUTER_API_KEY = "fake-openrouter-key-not-real";
		process.env.GROQ_API_KEY = "fake-groq-key-not-real";
		expect(resolveProviderKey("minimax")).toBeUndefined();
		const seen: Seen[] = [];
		mockFetch(seen);
		await expect(call("minimax")).rejects.toThrow("No API key for minimax");
		expect(seen.length).toBe(0);
	});

	test("the vault key resolves on the AI-SDK path too", async () => {
		const { storeVaultKey } = await import("../../secrets/key-vault");
		storeVaultKey("MINIMAX_API_KEY", "fake-vaulted-minimax-key");
		const seen: Seen[] = [];
		mockFetch(seen);
		await call("minimax");
		expect(seen[0].auth).toBe("Bearer fake-vaulted-minimax-key");
	});
});

describe("minimax is a chat runtime, not an Ollama model (#4622)", () => {
	test("providerToRuntime keeps minimax; local and unknown names are unchanged", async () => {
		const { providerToRuntime } = await import("../../../apps/tui/src/lib/model-selection");
		expect(providerToRuntime("minimax")).toBe("minimax");
		expect(providerToRuntime("ollama")).toBe("ollama");
		expect(providerToRuntime("openrouter-free")).toBe("openrouter");
		expect(providerToRuntime("no-such-provider")).toBe("ollama");
	});

	test("a saved minimax choice is not set aside for Ollama", async () => {
		const { resolveChatChoice } = await import("../../eight/run");
		const choice = await resolveChatChoice(
			{},
			{
				saved: { provider: "minimax", model: "some-model" },
				reachable: async () => true,
				ollamaUp: async () => true,
				ollamaModel: async () => "local-model",
			},
		);
		expect(choice.provider).toBe("minimax");
		expect(choice.notice).toBeUndefined();
	});
});
