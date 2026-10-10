import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, VaultUnreadableError } from "./index";
import {
	FileKeyBackend,
	LibsecretBackend,
	MacKeychainBackend,
	type Run,
	deleteVaultKey,
	keyVaultProblem,
	last4,
	currentKeyOwner,
	listVaultKeys,
	maskKey,
	readVaultKey,
	resetKeyVault,
	setKeyOwner,
	storeVaultKey,
} from "./key-vault";

const KEY = "hf_SECRETVALUE1234567890abcd";
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyvault-"));
});
afterEach(() => {
	resetKeyVault();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake OS tool that records every argv and stdin it is given. */
function fakeRun() {
	const calls: { cmd: string; args: string[]; stdin?: string }[] = [];
	const store = new Map<string, string>();
	const run: Run = (cmd, args, stdin) => {
		calls.push({ cmd, args, stdin });
		if (cmd === "security" && args[0] === "-i") {
			const m = stdin?.match(/-a (\S+) -X (\S+)/);
			if (m) store.set(m[1], Buffer.from(m[2], "hex").toString("utf8"));
			return { ok: true, stdout: "" };
		}
		if (cmd === "security" && args[0] === "find-generic-password") {
			const v = store.get(args[args.indexOf("-a") + 1]);
			return { ok: v !== undefined, stdout: v ? `${v}\n` : "" };
		}
		if (cmd === "secret-tool" && args[0] === "store") {
			store.set(args[args.length - 1], stdin ?? "");
			return { ok: true, stdout: "" };
		}
		if (cmd === "secret-tool" && args[0] === "lookup") {
			const v = store.get(args[args.length - 1]);
			return { ok: v !== undefined, stdout: v ?? "" };
		}
		return { ok: true, stdout: "" };
	};
	return { run, calls };
}

describe("OS keychain backends", () => {
	test("macOS: key travels on stdin, never in argv", () => {
		const { run, calls } = fakeRun();
		const b = new MacKeychainBackend(run);
		b.set("HF_TOKEN", KEY);
		expect(b.get("HF_TOKEN")).toBe(KEY);
		for (const c of calls) expect(c.args.join(" ")).not.toContain(KEY);
		for (const c of calls) expect(c.args.join(" ")).not.toContain(Buffer.from(KEY).toString("hex"));
		expect(b.list()).toEqual(["HF_TOKEN"]);
	});

	test("libsecret: key travels on stdin, never in argv", () => {
		const { run, calls } = fakeRun();
		const b = new LibsecretBackend(run);
		b.set("HF_TOKEN", KEY);
		expect(b.get("HF_TOKEN")).toBe(KEY);
		for (const c of calls) expect(c.args.join(" ")).not.toContain(KEY);
	});
});

describe("vault facade", () => {
	test("keychain failure falls back to the file vault and the key still resolves", () => {
		const failing = new MacKeychainBackend(() => ({ ok: false, stdout: "" }));
		const file = new FileKeyBackend(path.join(dir, "vault.enc"));
		resetKeyVault({ primary: failing, file });
		expect(storeVaultKey("HF_TOKEN", KEY)).toBe("file");
		resetKeyVault({ primary: failing, file });
		expect(readVaultKey("HF_TOKEN")).toBe(KEY);
	});

	test("list shows name and last 4 only; delete removes it", () => {
		const file = new FileKeyBackend(path.join(dir, "vault.enc"));
		resetKeyVault({ primary: file, file });
		storeVaultKey("HF_TOKEN", KEY);
		const rows = listVaultKeys();
		expect(rows).toEqual([{ name: "HF_TOKEN", last4: KEY.slice(-4), backend: "file" }]);
		expect(JSON.stringify(rows)).not.toContain(KEY);
		expect(deleteVaultKey("HF_TOKEN")).toBe(true);
		expect(readVaultKey("HF_TOKEN")).toBeUndefined();
		expect(listVaultKeys()).toEqual([]);
	});

	test("rejects empty keys and unsafe names", () => {
		const file = new FileKeyBackend(path.join(dir, "vault.enc"));
		resetKeyVault({ primary: file, file });
		expect(() => storeVaultKey("HF_TOKEN", "   ")).toThrow();
		expect(() => storeVaultKey("bad name; rm", KEY)).toThrow();
	});
});

describe("masking", () => {
	test("maskKey renders only bullets", () => {
		expect(maskKey(KEY)).toBe("•".repeat(KEY.length));
		expect(maskKey(KEY)).not.toContain("h");
		expect(last4(KEY)).toBe(KEY.slice(-4));
		expect(last4("abc")).toBe("***");
	});
});

describe("file modes", () => {
	test("file vault is created 0600 and a loose existing file is re-chmodded to 0600", () => {
		const p = path.join(dir, "vault.enc");
		const file = new FileKeyBackend(p);
		file.set("A_KEY", KEY);
		expect(fs.statSync(p).mode & 0o777).toBe(0o600);
		fs.chmodSync(p, 0o644);
		file.set("B_KEY", KEY);
		expect(fs.statSync(p).mode & 0o777).toBe(0o600);
	});
});

describe("per-user isolation", () => {
	function useFile() {
		const file = new FileKeyBackend(path.join(dir, "vault.enc"));
		resetKeyVault({ primary: file, file });
		return file;
	}

	test("two signed-in users never see each other's keys", () => {
		useFile();
		setKeyOwner("user_A");
		storeVaultKey("HF_TOKEN", "key-of-A-1111");
		setKeyOwner("user_B");
		expect(readVaultKey("HF_TOKEN")).toBeUndefined();
		expect(listVaultKeys()).toEqual([]);
		storeVaultKey("HF_TOKEN", "key-of-B-2222");
		expect(deleteVaultKey("OTHER")).toBe(false);
		setKeyOwner("user_A");
		expect(readVaultKey("HF_TOKEN")).toBe("key-of-A-1111");
		expect(listVaultKeys().map((r) => r.last4)).toEqual(["1111"]);
	});

	test("B deleting a name does not remove A's key", () => {
		useFile();
		setKeyOwner("user_A");
		storeVaultKey("HF_TOKEN", "key-of-A-1111");
		setKeyOwner("user_B");
		expect(deleteVaultKey("HF_TOKEN")).toBe(false);
		setKeyOwner("user_A");
		expect(readVaultKey("HF_TOKEN")).toBe("key-of-A-1111");
	});

	test("signed out uses the local OS user and does not see a signed-in user's keys", () => {
		useFile();
		setKeyOwner("user_A");
		storeVaultKey("HF_TOKEN", "key-of-A-1111");
		setKeyOwner(null);
		expect(currentKeyOwner()).toBe(`os:${os.userInfo().username}`);
		expect(readVaultKey("HF_TOKEN")).toBeUndefined();
		storeVaultKey("HF_TOKEN", "local-key-3333");
		setKeyOwner("user_A");
		expect(readVaultKey("HF_TOKEN")).toBe("key-of-A-1111");
		setKeyOwner(null);
		expect(readVaultKey("HF_TOKEN")).toBe("local-key-3333");
	});

	test("owner ids are sanitised and cannot reach another namespace", () => {
		useFile();
		setKeyOwner("user_A");
		storeVaultKey("HF_TOKEN", "key-of-A-1111");
		setKeyOwner("user_A/../x");
		expect(readVaultKey("HF_TOKEN")).toBeUndefined();
	});
});

describe("unreadable file vault fails loudly", () => {
	const corrupt = "{ not json, but maybe holds real entries";

	test("an unreadable vault throws, is left byte-identical, and a private copy is kept", () => {
		const p = path.join(dir, "vault.enc");
		fs.writeFileSync(p, corrupt, { mode: 0o600 });
		expect(() => new SecretVault(p)).toThrow(VaultUnreadableError);
		expect(fs.readFileSync(p, "utf8")).toBe(corrupt);
		const copies = fs.readdirSync(dir).filter((f) => f.startsWith("vault.enc.unreadable-"));
		expect(copies.length).toBe(1);
		expect(fs.readFileSync(path.join(dir, copies[0]), "utf8")).toBe(corrupt);
		expect(fs.statSync(path.join(dir, copies[0])).mode & 0o777).toBe(0o600);
		// A second attempt does not pile up copies.
		expect(() => new SecretVault(p)).toThrow();
		expect(fs.readdirSync(dir).filter((f) => f.startsWith("vault.enc.unreadable-")).length).toBe(1);
	});

	test("an unsupported version or shape is not treated as empty", () => {
		const p = path.join(dir, "vault.enc");
		fs.writeFileSync(p, JSON.stringify({ version: 2, entries: {} }));
		expect(() => new SecretVault(p)).toThrow(VaultUnreadableError);
		fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [] }));
		expect(() => new SecretVault(p)).toThrow(VaultUnreadableError);
	});

	test("the error message carries no vault contents", () => {
		const p = path.join(dir, "vault.enc");
		fs.writeFileSync(p, `${corrupt} ${KEY}`);
		try {
			new SecretVault(p);
		} catch (e) {
			expect(String((e as Error).message)).not.toContain(KEY);
		}
	});

	test("a blank or missing file is an empty vault, and saving works", () => {
		const p = path.join(dir, "vault.enc");
		fs.writeFileSync(p, "  \n");
		const v = new SecretVault(p);
		v.set("A", "1");
		expect(new SecretVault(p).get("A")).toBe("1");
	});

	test("facade: store throws, list and read do not throw, the problem is reported, nothing is overwritten", () => {
		const p = path.join(dir, "vault.enc");
		fs.writeFileSync(p, corrupt);
		const prev = process.env.EIGHT_DATA_DIR;
		process.env.EIGHT_DATA_DIR = dir;
		try {
			const failing = new MacKeychainBackend(() => ({ ok: false, stdout: "" }));
			resetKeyVault({ primary: failing });
			// The file vault is opened lazily; the first touch fails loudly.
			expect(() => storeVaultKey("HF_TOKEN", KEY)).toThrow();
			expect(readVaultKey("HF_TOKEN")).toBeUndefined();
			expect(listVaultKeys()).toEqual([]);
			expect(deleteVaultKey("HF_TOKEN")).toBe(false);
			expect(keyVaultProblem()).toContain("could not be read");
			expect(fs.readFileSync(p, "utf8")).toBe(corrupt);
		} finally {
			if (prev === undefined) delete process.env.EIGHT_DATA_DIR;
			else process.env.EIGHT_DATA_DIR = prev;
		}
	});

	test("save is atomic and owner-only: no temp file left, mode 0600, directory 0700 when created", () => {
		const sub = path.join(dir, "fresh", "vault.enc");
		const v = new SecretVault(sub);
		v.set("A", KEY);
		expect(fs.readdirSync(path.dirname(sub))).toEqual(["vault.enc"]);
		expect(fs.statSync(sub).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(sub)).mode & 0o777).toBe(0o700);
		expect(fs.readFileSync(sub, "utf8")).not.toContain(KEY);
	});
});

describe("keychain index and account hygiene", () => {
	test("each owner has its own index: one owner's list never names another's keys", () => {
		const { run, calls } = fakeRun();
		const b = new MacKeychainBackend(run);
		b.set("user:A/HF_TOKEN", KEY);
		b.set("user:B/OPENAI_API_KEY", KEY);
		expect(b.list("user:A/")).toEqual(["user:A/HF_TOKEN"]);
		expect(b.list("user:B/")).toEqual(["user:B/OPENAI_API_KEY"]);
		const wrote = calls.filter((c) => c.args[0] === "-i").map((c) => c.stdin ?? "");
		for (const line of wrote) {
			if (line.includes("__index__:user:A")) expect(line).not.toContain(Buffer.from("user:B/").toString("hex"));
		}
	});

	test("an account with spaces or newlines is refused, so no second command can be injected", () => {
		const { run, calls } = fakeRun();
		const b = new MacKeychainBackend(run);
		expect(() => b.set("os:bad user/HF_TOKEN", KEY)).toThrow();
		expect(() => b.set("os:x\ndelete-generic-password -s a/HF_TOKEN", KEY)).toThrow();
		expect(calls.filter((c) => c.args[0] === "-i").length).toBe(0);
	});

	test("no call carries the key in argv, through the whole facade", () => {
		const { run, calls } = fakeRun();
		const mac = new MacKeychainBackend(run);
		resetKeyVault({ primary: mac, file: new FileKeyBackend(path.join(dir, "vault.enc")) });
		setKeyOwner("user_A");
		storeVaultKey("HF_TOKEN", KEY);
		readVaultKey("HF_TOKEN");
		listVaultKeys();
		deleteVaultKey("HF_TOKEN");
		for (const c of calls) expect([c.cmd, ...c.args].join(" ")).not.toContain(KEY);
	});
});
