import { afterAll, describe, expect, test } from "bun:test";
import { KeychainVault } from "./keychain";
import { describeVaultContract } from "./vault-contract";

const isMac = process.platform === "darwin";
const services: string[] = [];
const testService = (suffix: string | number) => {
	const service = `8gent-secrets-test-${process.pid}-${suffix}`;
	services.push(service);
	return service;
};

// The vault API cannot remove its own __index__ entry, so drop every item
// under each test service directly.
if (isMac) {
	afterAll(async () => {
		for (const service of services) {
			while (
				(await Bun.spawn(["security", "delete-generic-password", "-s", service]).exited) === 0
			) {}
		}
	}, 30_000);
}

let serial = 0;

describeVaultContract(
	"KeychainVault",
	() => new KeychainVault({ service: testService(serial++) }),
	isMac ? false : "requires macOS",
);

describe.skipIf(isMac)("KeychainVault on non-macOS", () => {
	test("constructor throws on non-macOS platforms", () => {
		expect(() => new KeychainVault({ service: "8gent-secrets-test" })).toThrow(/macOS/);
	});
});

describe.skipIf(!isMac)("KeychainVault value encoding", () => {
	test("an ASCII value that looks like hex is returned verbatim", async () => {
		const vault = new KeychainVault({ service: testService("hex") });
		await vault.set("HEXLIKE", "deadbeef");
		expect(await vault.get("HEXLIKE")).toBe("deadbeef");
	}, 30_000);
});
