/**
 * hasCredentials is asked on every failover hop of every turn, so it must be a
 * pure read: AuthRotator.getKey bumps lastUsed, rewrites auth-profiles.json
 * (plaintext keys) and advances the round-robin. The check peeks instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileKeyBackend, resetKeyVault } from "../../secrets/key-vault";
import { AuthRotator } from "../auth-rotation";
import { ProviderManager } from "../index";

let home: string;
let file: string;
let saved: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "peek-"));
	const vault = new FileKeyBackend(path.join(home, "vault.enc"));
	resetKeyVault({ primary: vault, file: vault });
	saved = process.env.OPENROUTER_API_KEY;
	Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
	file = path.join(home, "auth-profiles.json");
	const profiles = [
		{ id: "b", provider: "openrouter", apiKey: "sk-or-b", priority: 1, failCount: 0, lastUsed: 200 },
		{ id: "a", provider: "openrouter", apiKey: "sk-or-a", priority: 1, failCount: 0, lastUsed: 100 },
	];
	fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
});
afterEach(() => {
	if (saved === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
	else process.env.OPENROUTER_API_KEY = saved;
	resetKeyVault();
	fs.rmSync(home, { recursive: true, force: true });
});

describe("hasCredentials does not rotate keys", () => {
	test("does not rewrite auth-profiles.json and does not advance the round-robin", () => {
		const before = fs.readFileSync(file, "utf-8");
		const mtimeBefore = fs.statSync(file).mtimeMs;

		const pm = new ProviderManager(path.join(home, "providers.json"));
		// The manager's rotator reads ~/.8gent; point this one at the temp file.
		(pm as unknown as { authRotator: AuthRotator }).authRotator = new AuthRotator(file);
		// Failover asks once per hop per turn; five asks stand in for five hops.
		for (let i = 0; i < 5; i++) expect(pm.hasCredentials("openrouter")).toBe(true);

		expect(fs.readFileSync(file, "utf-8")).toBe(before);
		expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
		// Rotation order unchanged: the least-recently-used profile is still next.
		expect(pm.getApiKey("openrouter")).toBe("sk-or-a");
		expect(pm.getApiKey("openrouter")).toBe("sk-or-b");
	});

	test("AuthRotator.peekKey returns what getKey would, without taking it", () => {
		const before = fs.readFileSync(file, "utf-8");
		const rot = new AuthRotator(file);
		expect(rot.peekKey("openrouter")).toBe("sk-or-a");
		expect(rot.peekKey("openrouter")).toBe("sk-or-a");
		expect(rot.peekKey("groq")).toBeNull();
		expect(fs.readFileSync(file, "utf-8")).toBe(before);
		expect(rot.getKey("openrouter")).toBe("sk-or-a");
		expect(rot.peekKey("openrouter")).toBe("sk-or-b");
	});
});
