/** ProviderManager.hasCredentials: what failover asks before it hops to a provider. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileKeyBackend, resetKeyVault } from "../../secrets/key-vault";
import { ProviderManager } from "../index";

let home: string;
let saved: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "hascred-"));
	const file = new FileKeyBackend(path.join(home, "vault.enc"));
	resetKeyVault({ primary: file, file });
	saved = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "";
});
afterEach(() => {
	if (saved === undefined) {
		process.env.OPENROUTER_API_KEY = undefined;
		Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
	} else process.env.OPENROUTER_API_KEY = saved;
	resetKeyVault();
	fs.rmSync(home, { recursive: true, force: true });
});

describe("ProviderManager.hasCredentials", () => {
	test("hosted provider without a key is false, with a key is true", () => {
		const pm = new ProviderManager(path.join(home, "providers.json"));
		expect(pm.hasCredentials("openrouter")).toBe(false);
		process.env.OPENROUTER_API_KEY = "sk-or-test";
		expect(pm.hasCredentials("openrouter")).toBe(true);
	});

	test("local runtimes need no key", () => {
		const pm = new ProviderManager(path.join(home, "providers.json"));
		expect(pm.hasCredentials("ollama")).toBe(true);
		expect(pm.hasCredentials("8gent")).toBe(true);
	});
});
