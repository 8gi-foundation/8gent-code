import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderManager, isCloudProvider } from "./index";

// ── isCloudProvider: base-URL driven cloud detection ──────────────────────

describe("isCloudProvider", () => {
	test("localhost is local", () => {
		expect(isCloudProvider({ baseUrl: "http://localhost:11434" })).toBe(false);
		expect(isCloudProvider({ baseUrl: "http://127.0.0.1:1234/v1" })).toBe(false);
	});

	test("empty base URL (IPC/subprocess) is local", () => {
		expect(isCloudProvider({ baseUrl: "" })).toBe(false);
	});

	test("public https endpoints are cloud", () => {
		expect(isCloudProvider({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isCloudProvider({ baseUrl: "https://api.anthropic.com/v1" })).toBe(true);
		expect(isCloudProvider({ baseUrl: "https://api.openai.com/v1" })).toBe(true);
	});

	test("unparseable base URL fails safe (treated as cloud)", () => {
		expect(isCloudProvider({ baseUrl: "not a url" })).toBe(true);
	});

	test(".internal (Fly private net) fails safe (treated as cloud)", () => {
		expect(isCloudProvider({ baseUrl: "http://model-proxy.example.internal:3200" })).toBe(true);
	});
});

// ── Chokepoint behavior via ProviderManager.chat() ────────────────────────

const PROMPT_PII =
	"James Spalding wants Sarah Connor at sarah.connor@example.com called on +1 (415) 555-0182.";

let tmpDir: string;
let settingsPath: string;
const realFetch = globalThis.fetch;

function writeSettings(activeProvider: string, activeModel: string, providers: object): void {
	fs.writeFileSync(settingsPath, JSON.stringify({ activeProvider, activeModel, providers }));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-egress-"));
	settingsPath = path.join(tmpDir, "providers.json");
});

afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cloud egress gate", () => {
	test("cloud provider: outbound payload is anonymized, response de-anonymized", async () => {
		writeSettings("openrouter", "minimax/minimax-m2", {
			openrouter: { enabled: true, apiKey: "test-key" },
		});
		const mgr = new ProviderManager(settingsPath);

		let captured: any = null;
		globalThis.fetch = (async (url: string, init: any) => {
			captured = JSON.parse(init.body);
			// Echo a pseudonym back so we can prove de-anonymization on return.
			const personToken = captured.messages
				.map((m: any) => m.content)
				.join(" ")
				.match(/\[PERSON_\d+\]/)?.[0];
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: `Notified ${personToken}.` } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const res = await mgr.chat({ messages: [{ role: "user", content: PROMPT_PII }] });

		// What the cloud saw: NO raw PII.
		const outbound = captured.messages.map((m: any) => m.content).join("\n");
		expect(outbound).not.toContain("James Spalding");
		expect(outbound).not.toContain("Sarah Connor");
		expect(outbound).not.toContain("sarah.connor@example.com");
		expect(outbound).not.toContain("555-0182");
		expect(outbound).toMatch(/\[PERSON_\d+\]/);

		// What the caller got back: real values restored.
		expect(res.content).toMatch(/James Spalding|Sarah Connor/);
		expect(res.content).not.toMatch(/\[PERSON_\d+\]/);
	});

	test("local provider is NOT mangled (raw PII reaches localhost untouched)", async () => {
		writeSettings("ollama", "qwen3:latest", { ollama: { enabled: true } });
		const mgr = new ProviderManager(settingsPath);

		let captured: any = null;
		globalThis.fetch = (async (_url: string, init: any) => {
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ message: { content: "ok" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await mgr.chat({ messages: [{ role: "user", content: PROMPT_PII }] });

		const sent = captured.messages.map((m: any) => m.content).join("\n");
		// Local stays on device: real values pass through, no pseudonyms.
		expect(sent).toContain("James Spalding");
		expect(sent).toContain("sarah.connor@example.com");
		expect(sent).not.toMatch(/\[PERSON_\d+\]/);
	});
});

describe("minimax direct provider egress", () => {
	const prev = process.env.MINIMAX_API_KEY;
	afterEach(() => {
		if (prev === undefined) delete process.env.MINIMAX_API_KEY;
		else process.env.MINIMAX_API_KEY = prev;
	});

	test("disabled by default: not available without MINIMAX_API_KEY", () => {
		// getApiKey also reads the key vault (the OS keychain on a Mac) and
		// ~/.8gent/auth-profiles.json, so a key stored on the machine running the
		// test made this fail there. Bun reads HOME once at launch, so the check
		// runs in a child process with a temp HOME and the file vault forced.
		writeSettings("8gent", "eight-1.0-q3:14b", {});
		const home = path.join(tmpDir, "home");
		fs.mkdirSync(home);
		const env: Record<string, string> = {
			...process.env,
			HOME: home,
			EIGHT_KEY_BACKEND: "file",
		} as Record<string, string>;
		delete env.MINIMAX_API_KEY;
		delete env.EIGHT_DATA_DIR;
		delete env.EIGHT_PROVIDERS_SETTINGS_PATH;
		const script = `
			const { ProviderManager } = await import(${JSON.stringify(path.join(import.meta.dir, "index.ts"))});
			const mgr = new ProviderManager(${JSON.stringify(settingsPath)});
			const cfg = mgr.getProvider("minimax");
			console.log(JSON.stringify({
				enabled: cfg.enabled, apiKeyEnv: cfg.apiKeyEnv, baseUrl: cfg.baseUrl,
				listed: mgr.listEnabledProviders().map((p) => p.name).includes("minimax"),
			}));`;
		const run = Bun.spawnSync([process.execPath, "-e", script], { env, cwd: home });
		const out = run.stdout.toString().trim().split("\n").pop() ?? "";
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(out)).toEqual({
			enabled: false,
			apiKeyEnv: "MINIMAX_API_KEY",
			baseUrl: "https://api.minimax.io/v1",
			listed: false,
		});
	});

	test("key in env makes it available; outbound payload is anonymized", async () => {
		process.env.MINIMAX_API_KEY = "test-key";
		writeSettings("minimax", "MiniMax-M3", {});
		const mgr = new ProviderManager(settingsPath);
		expect(mgr.listEnabledProviders().map((p) => p.name)).toContain("minimax");

		let captured: any = null;
		let calledUrl = "";
		globalThis.fetch = (async (url: string, init: any) => {
			calledUrl = String(url);
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await mgr.chat({ messages: [{ role: "user", content: PROMPT_PII }] });
		expect(calledUrl).toContain("api.minimax.io");
		const outbound = captured.messages.map((m: any) => m.content).join("\n");
		expect(outbound).not.toContain("sarah.connor@example.com");
		expect(outbound).not.toContain("555-0182");
		expect(outbound).toMatch(/\[PERSON_\d+\]/);
	});
});
