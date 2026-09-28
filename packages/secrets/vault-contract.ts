import { afterAll, describe, expect, test } from "bun:test";
import type { OSVault } from "./os-vault";

const TIMEOUT = 30_000;

/**
 * Behavior every OSVault backend must share. `makeVault` must return a vault
 * whose store is empty and not shared with any earlier call.
 */
export function describeVaultContract(
	label: string,
	makeVault: () => OSVault,
	skip: false | string,
): void {
	if (skip !== false) {
		describe.skip(`${label} contract (skipped: ${skip})`, () => {
			test("contract", () => {});
		});
		return;
	}

	describe(`${label} contract`, () => {
		const made: OSVault[] = [];
		const fresh = (): OSVault => {
			const vault = makeVault();
			made.push(vault);
			return vault;
		};

		afterAll(async () => {
			for (const vault of made) {
				for (const key of await vault.list()) {
					await vault.delete(key);
				}
			}
		}, TIMEOUT);

		test(
			"set then get returns the value",
			async () => {
				const vault = fresh();
				await vault.set("API_KEY", "sk-test-123");
				expect(await vault.get("API_KEY")).toBe("sk-test-123");
			},
			TIMEOUT,
		);

		test(
			"get of a missing key is undefined",
			async () => {
				const vault = fresh();
				expect(await vault.get("DOES_NOT_EXIST")).toBeUndefined();
			},
			TIMEOUT,
		);

		test(
			"has reports presence",
			async () => {
				const vault = fresh();
				await vault.set("PRESENT", "yes");
				expect(await vault.has("PRESENT")).toBe(true);
				expect(await vault.has("ABSENT")).toBe(false);
			},
			TIMEOUT,
		);

		test(
			"set overwrites an existing value",
			async () => {
				const vault = fresh();
				await vault.set("MUTABLE", "first");
				await vault.set("MUTABLE", "second");
				expect(await vault.get("MUTABLE")).toBe("second");
			},
			TIMEOUT,
		);

		test(
			"delete removes the key from get and list",
			async () => {
				const vault = fresh();
				await vault.set("KEEP", "k");
				await vault.set("TO_DELETE", "bye");
				expect(await vault.delete("TO_DELETE")).toBe(true);
				expect(await vault.get("TO_DELETE")).toBeUndefined();
				expect(await vault.list()).toEqual(["KEEP"]);
			},
			TIMEOUT,
		);

		test(
			"delete of a missing key returns false",
			async () => {
				const vault = fresh();
				expect(await vault.delete("NEVER_EXISTED")).toBe(false);
			},
			TIMEOUT,
		);

		test(
			"list returns stored keys sorted",
			async () => {
				const vault = fresh();
				await vault.set("ZED", "z");
				await vault.set("ALPHA", "a");
				expect(await vault.list()).toEqual(["ALPHA", "ZED"]);
			},
			TIMEOUT,
		);

		test(
			"useSecret passes the value to the callback",
			async () => {
				const vault = fresh();
				await vault.set("TOKEN", "secret-value");
				expect(await vault.useSecret("TOKEN", async (value) => value.length)).toBe(12);
			},
			TIMEOUT,
		);

		test(
			"useSecret throws for a missing key",
			async () => {
				const vault = fresh();
				await expect(vault.useSecret("MISSING", async () => "ok")).rejects.toThrow(/not found/);
			},
			TIMEOUT,
		);

		test(
			"__index__ cannot be set",
			async () => {
				const vault = fresh();
				await expect(vault.set("__index__", "value")).rejects.toThrow(/Reserved/);
			},
			TIMEOUT,
		);

		test(
			"get of __index__ is undefined",
			async () => {
				const vault = fresh();
				await vault.set("ANY", "v");
				expect(await vault.get("__index__")).toBeUndefined();
			},
			TIMEOUT,
		);

		test(
			"a non-ASCII value round-trips",
			async () => {
				const vault = fresh();
				await vault.set("UNICODE", "päss-✓");
				expect(await vault.get("UNICODE")).toBe("päss-✓");
			},
			TIMEOUT,
		);
	});
}
