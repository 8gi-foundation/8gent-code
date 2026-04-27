import { afterAll, describe, expect, test } from "bun:test";
import { KeychainVault } from "./keychain";

const TEST_SERVICE = `8gent-secrets-test-${process.pid}`;

const skipOnNonMac = process.platform !== "darwin";

const cleanup = async () => {
	const vault = new KeychainVault({ service: TEST_SERVICE });
	for (const key of await vault.list()) {
		await vault.delete(key);
	}
};

if (!skipOnNonMac) {
	afterAll(cleanup);
}

describe.skipIf(skipOnNonMac)("KeychainVault", () => {
	test("stores and retrieves a secret", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("API_KEY", "sk-test-123");
		expect(await vault.get("API_KEY")).toBe("sk-test-123");
	});

	test("returns undefined for missing key", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		expect(await vault.get("DOES_NOT_EXIST")).toBeUndefined();
	});

	test("has() reports presence correctly", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("PRESENT", "yes");
		expect(await vault.has("PRESENT")).toBe(true);
		expect(await vault.has("ABSENT")).toBe(false);
	});

	test("delete() removes the secret and updates index", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("TO_DELETE", "bye");
		expect(await vault.delete("TO_DELETE")).toBe(true);
		expect(await vault.has("TO_DELETE")).toBe(false);
		expect(await vault.list()).not.toContain("TO_DELETE");
	});

	test("delete() returns false for missing key", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		expect(await vault.delete("NEVER_EXISTED")).toBe(false);
	});

	test("list() reflects all stored keys, sorted", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("ZED", "z");
		await vault.set("ALPHA", "a");
		const keys = await vault.list();
		expect(keys).toContain("ZED");
		expect(keys).toContain("ALPHA");
		expect(keys.indexOf("ALPHA")).toBeLessThan(keys.indexOf("ZED"));
	});

	test("set() overwrites existing value", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("MUTABLE", "first");
		await vault.set("MUTABLE", "second");
		expect(await vault.get("MUTABLE")).toBe("second");
	});

	test("useSecret() runs callback with decrypted value, returns result", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("TOKEN", "secret-value");
		const result = await vault.useSecret("TOKEN", async (value) => {
			return value.length;
		});
		expect(result).toBe("secret-value".length);
	});

	test("useSecret() throws when key is missing", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await expect(vault.useSecret("MISSING", async () => "ok")).rejects.toThrow(/not found/);
	});

	test("reserved __index__ key cannot be set", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await expect(vault.set("__index__", "value")).rejects.toThrow(/Reserved/);
	});

	test("get() on __index__ returns undefined (hidden)", async () => {
		const vault = new KeychainVault({ service: TEST_SERVICE });
		await vault.set("ANY", "v");
		expect(await vault.get("__index__")).toBeUndefined();
	});
});

describe.skipIf(!skipOnNonMac)("KeychainVault on non-macOS", () => {
	test("constructor throws on non-macOS platforms", () => {
		expect(() => new KeychainVault({ service: TEST_SERVICE })).toThrow(/macOS/);
	});
});
