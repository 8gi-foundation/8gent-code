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
import { scrubKey } from "../../ai/providers";
import { createModel } from "../../ai/providers";
import { FileKeyBackend, resetKeyVault } from "../../secrets/key-vault";
import { getProviderManager, resetProviderManager } from "../index";
import { isHostedChatProvider, resolveProviderKey } from "../key-resolver";
import {
	type PolicyState,
	type RoutingPolicy,
	readLedger,
	recordCall,
	updateCall,
} from "../locality";
import { LocalOnlyRefusal, type WireDeps, guardFetch } from "../locality-wire";

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

describe("a cloned repo's .env cannot redirect a key (8SO, #4622)", () => {
	test("a cwd .env declaring EIGHT_DATA_DIR or EIGHT_PROVIDERS_SETTINGS_PATH still sends the key only to the registry host", () => {
		const repo = path.join(home, "cloned");
		const evilDir = path.join(home, "evil");
		fs.mkdirSync(repo);
		fs.mkdirSync(evilDir);
		fs.writeFileSync(
			path.join(evilDir, "providers.json"),
			JSON.stringify({ providers: { minimax: { baseUrl: "https://evil.example/v1" } } }),
		);
		fs.writeFileSync(
			path.join(repo, ".env"),
			`EIGHT_DATA_DIR=${evilDir}\nEIGHT_PROVIDERS_SETTINGS_PATH=${path.join(evilDir, "providers.json")}\nMINIMAX_BASE_URL=https://evil.example/v1\n`,
		);
		const fakeHome = path.join(home, "home");
		fs.mkdirSync(fakeHome);
		const root = path.resolve(import.meta.dir, "../../..");
		const script = `
			import { createModel } from ${JSON.stringify(path.join(root, "packages/ai/providers"))};
			const seen = [];
			globalThis.fetch = async (u, i) => { seen.push([String(u), new Headers(i?.headers).get("authorization")]); return new Response("{}", { status: 200 }); };
			const m = createModel({ name: "minimax", model: "m" });
			try { await m.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }); } catch (e) {}
			console.log(JSON.stringify(seen));
		`;
		const r = Bun.spawnSync(["bun", "-e", script], {
			cwd: repo,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: fakeHome,
				TMPDIR: process.env.TMPDIR ?? "",
				NODE_ENV: "production",
				MINIMAX_API_KEY: "fake-minimax-key-not-real",
			},
		});
		const out = r.stdout.toString().trim().split("\n").pop() ?? "";
		const seen = JSON.parse(out) as Array<[string, string | null]>;
		for (const [url] of seen) expect(url).not.toContain("evil.example");
		expect(seen.length).toBe(1);
		expect(new URL(seen[0][0]).host).toBe("api.minimax.io");
	});

	test("the .env loader is an allowlist: only provider key variables pass", async () => {
		const { dotenvKeyIsAllowed } = await import("../../permissions/run-command-sandbox");
		const names = new Set(allKeyEnvs());
		for (const k of ["MINIMAX_API_KEY", "OPENROUTER_API_KEY", "SOMETHING_NEW_API_KEY"])
			expect(dotenvKeyIsAllowed(k, names), k).toBe(true);
		for (const k of [
			"HTTPS_PROXY",
			"https_proxy",
			"HTTP_PROXY",
			"ALL_PROXY",
			"NODE_TLS_REJECT_UNAUTHORIZED",
			"NODE_EXTRA_CA_CERTS",
			"EIGHT_DATA_DIR",
			"EIGHT_PROVIDERS_SETTINGS_PATH",
			"MINIMAX_BASE_URL",
			"LMSTUDIO_BASE_URL",
			"APFEL_BASE_URL",
			"HOME",
			"eight_data_dir",
			"minimax_api_key",
		])
			expect(dotenvKeyIsAllowed(k, names), k).toBe(false);
	});

	test("security keys are matched case-insensitively (Windows env names)", async () => {
		const { snapshotSecurityEnv } = await import("../../permissions/run-command-sandbox");
		const snap = snapshotSecurityEnv({ EIGHT_DATA_DIR: "/x" }, new Set(["eight_data_dir"]));
		expect(snap.values.EIGHT_DATA_DIR).toBeUndefined();
		expect(snap.ignored).toContain("EIGHT_DATA_DIR");
	});

	test("a hostile .env with a proxy and TLS-off never routes the key: dropped at load, local proxy gets no connection", async () => {
		const net = await import("node:net");
		let connections = 0;
		const srv = net.createServer((sock) => {
			connections++;
			sock.destroy();
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		const port = (srv.address() as { port: number }).port;
		const repo = path.join(home, "hostile");
		fs.mkdirSync(repo);
		fs.writeFileSync(
			path.join(repo, ".env"),
			`HTTPS_PROXY=http://127.0.0.1:${port}\nHTTP_PROXY=http://127.0.0.1:${port}\nhttps_proxy=http://127.0.0.1:${port}\nNODE_TLS_REJECT_UNAUTHORIZED=0\n`,
		);
		const root = path.resolve(import.meta.dir, "../../..");
		const script = `
			import { droppedNetworkEnv } from ${JSON.stringify(path.join(root, "packages/permissions/run-command-sandbox"))};
			import { guardedKeyedFetch } from ${JSON.stringify(path.join(root, "packages/ai/providers"))};
			const f = guardedKeyedFetch(fetch, "fake-key-not-real");
			try { await f("http://127.0.0.1:1/v1/x", { headers: { authorization: "Bearer fake-key-not-real" }, signal: AbortSignal.timeout(2000) }); } catch (e) {}
			console.log(JSON.stringify({ dropped: droppedNetworkEnv, left: [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.https_proxy, process.env.NODE_TLS_REJECT_UNAUTHORIZED] }));
		`;
		const r = Bun.spawnSync(["bun", "-e", script], {
			cwd: repo,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: path.join(home, "h2"),
				TMPDIR: process.env.TMPDIR ?? "",
				NODE_ENV: "production",
			},
		});
		srv.close();
		const out = JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "{}") as {
			dropped: string[];
			left: unknown[];
		};
		expect(out.dropped.sort()).toEqual(
			["HTTPS_PROXY", "HTTP_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "https_proxy"].sort(),
		);
		expect(out.left).toEqual([null, null, null, null]);
		expect(connections).toBe(0);
	});

	test("an endpoint override the user wrote in ~/.8gent/keys.env is honoured; a project .env one is dropped", async () => {
		const { trustedEnvValue, userDotenvCandidates, projectDotenvCandidates } = await import(
			"../../permissions/run-command-sandbox"
		);
		const env = { MINIMAX_BASE_URL: "https://api.minimaxi.com/v1" };
		expect(trustedEnvValue("MINIMAX_BASE_URL", env, new Set())).toBe("https://api.minimaxi.com/v1");
		expect(trustedEnvValue("MINIMAX_BASE_URL", env, new Set(["MINIMAX_BASE_URL"]))).toBeUndefined();
		expect(trustedEnvValue("MINIMAX_BASE_URL", env, new Set(["minimax_base_url"]))).toBeUndefined();
		expect(userDotenvCandidates("/h").some((f) => f.endsWith("keys.env"))).toBe(true);
		expect(projectDotenvCandidates("/p").some((f) => f.endsWith("keys.env"))).toBe(false);
	});
});

describe("settings trust is a real condition (#4622)", () => {
	test("settingsFileIsTrusted: real file in the user dir yes; symlink out, outside dir no; explicit or shell env yes", async () => {
		const { settingsFileIsTrusted } = await import("../index");
		const userDir = path.join(home, "u");
		const other = path.join(home, "other");
		fs.mkdirSync(userDir);
		fs.mkdirSync(other);
		const real = path.join(userDir, "providers.json");
		fs.writeFileSync(real, "{}");
		const outside = path.join(other, "providers.json");
		fs.writeFileSync(outside, "{}");
		const link = path.join(userDir, "linked.json");
		fs.symlinkSync(outside, link);
		const o = { explicit: false, fromTrustedEnv: false, userDirs: [userDir] };
		expect(settingsFileIsTrusted(real, o)).toBe(true);
		expect(settingsFileIsTrusted(path.join(userDir, "missing.json"), o)).toBe(true);
		expect(settingsFileIsTrusted(link, o)).toBe(false);
		expect(settingsFileIsTrusted(outside, o)).toBe(false);
		expect(settingsFileIsTrusted(outside, { ...o, explicit: true })).toBe(true);
		expect(settingsFileIsTrusted(outside, { ...o, fromTrustedEnv: true })).toBe(true);
	});

	test("an untrusted providers.json moving minimax gets no key; the origin (not just host) is compared", () => {
		const other = path.join(home, "elsewhere");
		fs.mkdirSync(other);
		const target = path.join(other, "providers.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ providers: { minimax: { baseUrl: "http://api.minimax.io/v1" } } }),
		);
		fs.symlinkSync(target, path.join(home, "providers.json"));
		resetProviderManager();
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const pm = getProviderManager();
		expect(pm.settingsTrusted).toBe(false);
		// same host, different scheme: an origin mismatch
		expect(pm.keyWithheldReason("minimax")).toContain("not its default endpoint");
		expect(resolveProviderKey("minimax")).toBeUndefined();
	});

	test("a session baseURL on another origin never receives the registry key", async () => {
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const seen: Seen[] = [];
		mockFetch(seen);
		const model = createModel({
			name: "minimax",
			model: "m",
			baseURL: "https://other.example/v1",
		}) as unknown as {
			doGenerate: (o: unknown) => Promise<unknown>;
		};
		await expect(
			model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
		).rejects.toThrow("No API key for minimax");
		expect(seen.length).toBe(0);
	});
});

describe("hardening", () => {
	test("a 401 that echoes the key is scrubbed at the SDK error boundary", async () => {
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: "bad key fake-minimax-key-not-real; Bearer fake-minimax-key-not-real",
				}),
				{
					status: 401,
					headers: { "content-type": "application/json" },
				},
			)) as unknown as typeof fetch;
		const e = (await call("minimax").then(
			() => null,
			(x) => x,
		)) as (Error & { responseBody?: string }) | null;
		expect(e).not.toBeNull();
		const all = `${e?.message} ${e?.responseBody ?? ""} ${e?.stack ?? ""}`;
		expect(all).not.toContain("fake-minimax-key-not-real");
	});

	test("Bearer tokens and the key value are scrubbed from errors", async () => {
		globalThis.fetch = (async () => {
			throw new Error(
				"boom Authorization: Bearer fake-minimax-key-not-real and fake-minimax-key-not-real again",
			);
		}) as unknown as typeof fetch;
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const e = await call("minimax").then(
			() => null,
			(x) => x as Error,
		);
		expect(e).not.toBeNull();
		expect(e?.message).not.toContain("fake-minimax-key-not-real");
		expect(scrubKey("Bearer abc.def-123 xyz", "xyz")).toBe("Bearer [REDACTED] [REDACTED]");
	});

	test("a cross-origin 307 never forwards Authorization", async () => {
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const hits: Array<{ url: string; auth: string | null }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			hits.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
			return new Response(null, {
				status: 307,
				headers: { location: "https://evil.example/steal" },
			});
		}) as unknown as typeof fetch;
		await expect(call("minimax")).rejects.toThrow("not followed");
		expect(hits.length).toBe(1);
		expect(hits.every((h) => !h.url.includes("evil.example"))).toBe(true);
	});

	test("a same-origin 307 is followed and keeps the key on that origin", async () => {
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const hits: Array<{ url: string; auth: string | null }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			hits.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
			if (hits.length === 1)
				return new Response(null, { status: 307, headers: { location: "/v1/other" } });
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
		await call("minimax");
		expect(hits.length).toBe(2);
		expect(new URL(hits[1].url).host).toBe("api.minimax.io");
		expect(hits[1].auth).toBe("Bearer fake-minimax-key-not-real");
	});
});

describe("local-only at the wire for keyed providers (#4607 + #4622)", () => {
	function wire(policy: RoutingPolicy) {
		const ledger = path.join(home, "locality.jsonl");
		const hits: string[] = [];
		const base = (async (input: RequestInfo | URL) => {
			hits.push(String(input));
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
		const state: PolicyState = { policy, localHosts: [] };
		const deps: WireDeps = {
			state: () => state,
			nameOf: (hp) => hp,
			record: (c) => recordCall(c, ledger),
			update: (id, u) => updateCall(id, u, ledger),
			notify: () => {},
		};
		globalThis.fetch = guardFetch(base, deps);
		return { ledger, hits };
	}

	test("local-only: minimax and groq are refused with LocalOnlyRefusal and write no ledger line", async () => {
		for (const name of ["minimax", "groq"]) {
			process.env[getProviderManager().getProvider(name).apiKeyEnv] = `fake-${name}-key-not-real`;
		}
		const { ledger, hits } = wire("local-only");
		for (const name of ["minimax", "groq"]) {
			await expect(call(name), name).rejects.toBeInstanceOf(LocalOnlyRefusal);
		}
		expect(hits).toEqual([]);
		expect(readLedger(ledger)).toEqual([]);
	});

	test("cloud allowed: one call writes exactly one ledger line", async () => {
		process.env.MINIMAX_API_KEY = "fake-minimax-key-not-real";
		const { ledger, hits } = wire("cloud-first");
		await call("minimax");
		expect(hits.length).toBe(1);
		expect(readLedger(ledger).length).toBe(1);
	});
});
