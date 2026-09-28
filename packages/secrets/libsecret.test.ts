import { afterAll, describe, expect, test } from "bun:test";
import { LibsecretVault } from "./libsecret";
import { describeVaultContract } from "./vault-contract";

const isLinux = process.platform === "linux";

const hasSecretTool = await (async () => {
	if (!isLinux) return false;
	try {
		const proc = Bun.spawn(["which", "secret-tool"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
})();

const services: string[] = [];

// The vault API cannot remove its own __index__ entry, so clear each test
// service directly.
if (isLinux && hasSecretTool) {
	afterAll(async () => {
		for (const service of services) {
			await Bun.spawn(["secret-tool", "clear", "service", service]).exited;
		}
	}, 30_000);
}

let serial = 0;

describeVaultContract(
	"LibsecretVault",
	() => {
		const service = `8gent-secrets-test-${process.pid}-${serial++}`;
		services.push(service);
		return new LibsecretVault({ service });
	},
	isLinux && hasSecretTool ? false : "requires Linux with secret-tool",
);

describe.skipIf(isLinux)("LibsecretVault on non-Linux", () => {
	test("constructor throws on non-Linux platforms", () => {
		expect(() => new LibsecretVault({ service: "8gent-secrets-test" })).toThrow(/Linux/);
	});
});
