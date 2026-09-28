import { afterAll, describe, expect, test } from "bun:test";
import { getOSVault } from "./os-vault";

describe("getOSVault", () => {
	test("rejects on a platform with no OS vault", async () => {
		await expect(getOSVault("aix")).rejects.toThrow(
			'No OS vault available for platform "aix". Use SecretVault.',
		);
	});
});

describe.skipIf(process.platform !== "win32")(
	"getOSVault on Windows (requires Windows (DPAPI via powershell.exe))",
	() => {
		const key = `8GENT_OS_VAULT_TEST_${process.pid}`;
		afterAll(async () => {
			await (await getOSVault()).delete(key);
		});

		test("round-trips through the default vault", async () => {
			const vault = await getOSVault();
			await vault.set(key, "os-vault-value");
			expect(await vault.get(key)).toBe("os-vault-value");
			expect(await vault.delete(key)).toBe(true);
			expect(await vault.get(key)).toBeUndefined();
		}, 60_000);
	},
);
