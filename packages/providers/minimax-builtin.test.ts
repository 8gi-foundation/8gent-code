import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Fake values only. Never a real key.
const FAKE_KEY = "fake-minimax-key-for-tests";

let tmpDir: string;
let settingsPath: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
	"MINIMAX_API_KEY",
	"MINIMAX_BASE_URL",
	"EIGHT_DATA_DIR",
	"EIGHT_PROVIDERS_SETTINGS_PATH",
];

beforeEach(() => {
	for (const k of ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-builtin-"));
	settingsPath = path.join(tmpDir, "providers.json");
	process.env.EIGHT_DATA_DIR = tmpDir;
});

afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Fresh module instance per call so module-load env (MINIMAX_BASE_URL) is re-read.
async function load() {
	return (await import(`./index?minimax=${Math.random()}`)) as typeof import("./index");
}

describe("minimax built-in provider", () => {
	test("appears in the declared list", async () => {
		const { ProviderManager, PROVIDER_NAMES } = await load();
		const pm = new ProviderManager(settingsPath);
		expect(PROVIDER_NAMES).toContain("minimax");
		expect(pm.isKnownProvider("minimax")).toBe(true);
		expect(pm.listProviders().map((p) => p.name)).toContain("minimax");
		const cfg = pm.getProvider("minimax");
		expect(cfg.apiKeyEnv).toBe("MINIMAX_API_KEY");
		expect(cfg.baseUrl).toBe("https://api.minimax.io/v1");
		expect(pm.compatFor(cfg)).toBe("openai");
	});

	test("unconfigured with no env var, configured with one", async () => {
		const { ProviderManager } = await load();
		const pm = new ProviderManager(settingsPath);
		expect(pm.getApiKey("minimax")).toBeNull();
		expect(pm.listEnabledProviders().map((p) => p.name)).not.toContain("minimax");

		process.env.MINIMAX_API_KEY = FAKE_KEY;
		expect(pm.getApiKey("minimax")).toBe(FAKE_KEY);
		expect(pm.listEnabledProviders().map((p) => p.name)).toContain("minimax");
	});

	test("MINIMAX_BASE_URL overrides the base URL", async () => {
		process.env.MINIMAX_BASE_URL = "https://example.invalid/v1";
		const { ProviderManager } = await load();
		const pm = new ProviderManager(settingsPath);
		expect(pm.getProvider("minimax").baseUrl).toBe("https://example.invalid/v1");
	});

	test("selecting it leaves every other provider untouched", async () => {
		const { ProviderManager, PROVIDER_NAMES } = await load();
		const pm = new ProviderManager(settingsPath);
		const others = PROVIDER_NAMES.filter((n) => n !== "minimax");
		const before = JSON.stringify(others.map((n) => pm.getProvider(n)));
		pm.setActiveProvider("minimax");
		expect(pm.getActiveProvider().name).toBe("minimax");
		expect(pm.getActiveModel()).toBe("MiniMax-M2.7");
		expect(JSON.stringify(others.map((n) => pm.getProvider(n)))).toBe(before);
	});
});
