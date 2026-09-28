import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DpapiCipher, DpapiVault, encodePowerShellCommand } from "./dpapi";
import { describeVaultContract } from "./vault-contract";

const isWindows = process.platform === "win32";

const scramble = (bytes: Uint8Array): Uint8Array => bytes.map((b) => b ^ 0x5a).reverse();

const fakeCipher: DpapiCipher = {
	protect: async (plain) => scramble(plain),
	unprotect: async (sealed) => scramble(sealed),
};

const root = await mkdtemp(join(tmpdir(), "8gent-dpapi-test-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let serial = 0;
const freshDir = () => join(root, `vault-${serial++}`);

describeVaultContract(
	"DpapiVault (fake cipher)",
	() => new DpapiVault({ dir: freshDir(), cipher: fakeCipher }),
	false,
);

describe("DpapiVault on disk", () => {
	test("keys that differ only in case are stored in separate hex-named files", async () => {
		const dir = freshDir();
		const vault = new DpapiVault({ dir, cipher: fakeCipher });
		await vault.set("Token", "mixed");
		await vault.set("TOKEN", "upper");
		expect((await readdir(dir)).sort()).toEqual(["544f4b454e.dpapi", "546f6b656e.dpapi"]);
		expect(await vault.get("Token")).toBe("mixed");
		expect(await vault.get("TOKEN")).toBe("upper");
	});

	test("the stored file does not contain the plaintext", async () => {
		const dir = freshDir();
		const vault = new DpapiVault({ dir, cipher: fakeCipher });
		await vault.set("API_KEY", "sk-plaintext-marker");
		const bytes = await readFile(join(dir, "4150495f4b4559.dpapi"));
		expect(bytes.toString("utf8").includes("sk-plaintext-marker")).toBe(false);
		expect(bytes.length).toBe(19);
	});
});

describe.skipIf(isWindows)("DpapiVault without a cipher on non-Windows", () => {
	test("constructor throws", () => {
		expect(() => new DpapiVault({ dir: freshDir() })).toThrow(/requires Windows/);
	});
});

describe.skipIf(!isWindows)(
	"DpapiVault with powershell.exe (requires Windows (DPAPI via powershell.exe))",
	() => {
		let dir: string;
		beforeAll(async () => {
			dir = await mkdtemp(join(tmpdir(), "8gent-dpapi-real-"));
		});
		afterAll(() => rm(dir, { recursive: true, force: true }));

		test("round-trips, overwrites, deletes, and never stores plaintext", async () => {
			const vault = new DpapiVault({ dir });
			await vault.set("API_KEY", "sk-real-first");
			expect(await vault.get("API_KEY")).toBe("sk-real-first");
			await vault.set("API_KEY", "sk-real-second");
			expect(await vault.get("API_KEY")).toBe("sk-real-second");
			const bytes = await readFile(join(dir, "4150495f4b4559.dpapi"));
			expect(bytes.toString("utf8").includes("sk-real-second")).toBe(false);
			await vault.set("UNICODE", "päss-✓");
			expect(await vault.get("UNICODE")).toBe("päss-✓");
			expect(await vault.list()).toEqual(["API_KEY", "UNICODE"]);
			expect(await vault.delete("API_KEY")).toBe(true);
			expect(await vault.get("API_KEY")).toBeUndefined();
			expect(await vault.get("NEVER_SET")).toBeUndefined();
		}, 60_000);
	},
);

describe("encodePowerShellCommand", () => {
	test("encodes the script as base64 of UTF-16LE", () => {
		expect(encodePowerShellCommand("echo 1")).toBe("ZQBjAGgAbwAgADEA");
	});
});
