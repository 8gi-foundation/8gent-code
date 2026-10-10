/**
 * Provider key resolution (#3848): env, then vault, then plain file value.
 * And the leak scan: after a key is entered and one mocked call is made, no
 * file under the fixture HOME contains the key.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileKeyBackend, resetKeyVault, storeVaultKey } from "../../secrets/key-vault";
import { ProviderManager } from "../index";

const KEY = "hf_LEAKCANARY_9f8e7d6c5b4a3210";
const ENV = "HF_TEST_TOKEN_3848";
let home: string;
let settings: string;
let savedEnv: string | undefined;
let savedFetch: typeof fetch;

function manager(providers: Record<string, unknown>): ProviderManager {
	fs.writeFileSync(settings, JSON.stringify({ providers }, null, 2));
	return new ProviderManager(settings);
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "keyres-"));
	settings = path.join(home, ".8gent", "providers.json");
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	const file = new FileKeyBackend(path.join(home, ".8gent", "vault.enc"));
	resetKeyVault({ primary: file, file });
	savedEnv = process.env[ENV];
	delete process.env[ENV];
	savedFetch = globalThis.fetch;
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV];
	else process.env[ENV] = savedEnv;
	globalThis.fetch = savedFetch;
	resetKeyVault();
	fs.rmSync(home, { recursive: true, force: true });
});

const hf = (extra: Record<string, unknown> = {}) => ({
	hf: {
		baseUrl: "https://router.huggingface.co/v1",
		apiKeyEnv: ENV,
		defaultModel: "m",
		...extra,
	},
});

describe("resolution order", () => {
	test("env beats vault beats plain file value", () => {
		const pm = manager(hf({ apiKey: "plain-file-value" }));
		storeVaultKey(ENV, "vault-value");
		process.env[ENV] = "env-value";
		expect(pm.getApiKey("hf")).toBe("env-value");
		delete process.env[ENV];
		expect(pm.getApiKey("hf")).toBe("vault-value");
		resetKeyVault({ primary: new FileKeyBackend(path.join(home, "other.enc")) });
		expect(pm.getApiKey("hf")).toBe("plain-file-value");
	});

	test("a declared provider can name its vault entry with apiKeyRef", () => {
		const pm = manager({
			mine: { baseUrl: "https://example.com/v1", apiKeyRef: "my-ref", defaultModel: "m" },
		});
		expect(pm.getApiKey("mine")).toBeNull();
		storeVaultKey("my-ref", "ref-value");
		expect(pm.getProvider("mine").apiKeyRef).toBe("my-ref");
		expect(pm.getApiKey("mine")).toBe("ref-value");
	});

	test("built-in provider reads its apiKeyEnv entry from the vault", () => {
		const pm = manager({});
		const name = pm.getProvider("openrouter").apiKeyEnv;
		const prev = process.env[name];
		delete process.env[name];
		try {
			storeVaultKey(name, "or-vault");
			expect(pm.getApiKey("openrouter")).toBe("or-vault");
		} finally {
			if (prev !== undefined) process.env[name] = prev;
		}
	});

	test("plain apiKey warns once, by provider name only", () => {
		const pm = manager(hf({ apiKey: "plain-file-value" }));
		pm.getApiKey("hf");
		expect(pm.takePlainKeyWarnings()).toEqual(["hf"]);
		pm.getApiKey("hf");
		expect(pm.takePlainKeyWarnings()).toEqual([]);
	});
});

describe("storing and file safety", () => {
	test("setApiKey goes to the vault, never as text in providers.json; file is 0600", () => {
		const pm = manager(hf());
		fs.chmodSync(settings, 0o644);
		pm.setApiKey("hf", KEY);
		const onDisk = fs.readFileSync(settings, "utf8");
		expect(onDisk).not.toContain(KEY);
		expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
		expect(pm.getApiKey("hf")).toBe(KEY);
	});

	test("a keyless declared provider gets a ref, not a literal key", () => {
		const pm = manager({ box: { baseUrl: "https://example.com/v1", defaultModel: "m" } });
		pm.setApiKey("box", KEY);
		expect(fs.readFileSync(settings, "utf8")).not.toContain(KEY);
		expect(pm.getProvider("box").apiKeyRef).toBe("provider-box");
		expect(pm.getApiKey("box")).toBe(KEY);
	});
});

/** Every file under `root`, recursively. */
function walk(root: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		const p = path.join(root, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

describe("leak scan", () => {
	test("after entering a key and one mocked provider call, no file under HOME holds the key", async () => {
		const pm = manager(hf());
		pm.setApiKey("hf", KEY);
		pm.setActiveProvider("hf");

		let sentAuth = "";
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			sentAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		const res = await pm.chat({ messages: [{ role: "user", content: "hello" }] } as never);
		expect(res.content).toBe("ok");
		// The key really was used for the call...
		expect(sentAuth).toBe(`Bearer ${KEY}`);

		// ...and is on no disk in the clear.
		const needles = [KEY, Buffer.from(KEY).toString("hex"), Buffer.from(KEY).toString("base64")];
		const files = walk(home);
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const bytes = fs.readFileSync(f).toString("latin1");
			for (const n of needles) expect(bytes.includes(n)).toBe(false);
		}
	});
});
