/**
 * 8gent Code - provider key vault (sync facade)
 *
 * One place that stores and reads provider API keys:
 *   1. OS keychain by default (macOS Keychain, libsecret on Linux).
 *   2. The encrypted file vault (SecretVault) only when no OS keychain works.
 *
 * Synchronous on purpose: `ProviderManager.getApiKey()` is sync and is called
 * from list renderers, so the async KeychainVault / LibsecretVault cannot sit
 * behind it. Reads are cached per process; a set or delete refreshes the cache.
 *
 * A raw key never leaves this module except through `readVaultKey()`, and is
 * never put on a command line: the OS tools get the value on stdin.
 */

import * as os from "node:os";
import * as path from "node:path";
import { SecretVault } from "./index";

const SERVICE = "8gent-provider-keys";
const INDEX = "__index__";

export type KeyBackendName = "keychain" | "libsecret" | "file";

export interface KeyBackend {
	readonly name: KeyBackendName;
	get(name: string): string | undefined;
	set(name: string, value: string): void;
	delete(name: string): boolean;
	/** Names stored under `prefix` (an owner, e.g. "user:abc/"). */
	list(prefix?: string): string[];
}

export interface RunResult {
	ok: boolean;
	stdout: string;
}
/** Runs a command with `stdin` piped in. Never throws. */
export type Run = (cmd: string, args: string[], stdin?: string) => RunResult;

const defaultRun: Run = (cmd, args, stdin) => {
	try {
		const proc = Bun.spawnSync([cmd, ...args], {
			stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		return { ok: proc.exitCode === 0, stdout: proc.stdout.toString() };
	} catch {
		return { ok: false, stdout: "" };
	}
};

// ---------- Index helpers (OS keychains cannot enumerate by service) ----------

function parseIndex(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
	} catch {
		return [];
	}
}

abstract class IndexedBackend implements KeyBackend {
	abstract readonly name: KeyBackendName;
	protected abstract read(account: string): string | undefined;
	protected abstract write(account: string, value: string): boolean;
	protected abstract remove(account: string): void;

	/**
	 * One index entry PER OWNER ("<owner>/" prefix of the id), so the keychain
	 * never holds a single list naming every user's keys.
	 */
	private indexAccount(prefix: string): string {
		return `${INDEX}:${prefix.replace(/\/$/, "")}`;
	}
	private ownerPrefix(name: string): string {
		const i = name.indexOf("/");
		return i < 0 ? "" : name.slice(0, i + 1);
	}

	get(name: string): string | undefined {
		return name.startsWith(INDEX) ? undefined : this.read(name);
	}
	set(name: string, value: string): void {
		if (name.startsWith(INDEX)) throw new Error("Reserved key name");
		if (!this.write(name, value)) throw new Error(`${this.name} write failed`);
		const account = this.indexAccount(this.ownerPrefix(name));
		const index = parseIndex(this.read(account));
		if (!index.includes(name)) {
			index.push(name);
			this.write(account, JSON.stringify(index.sort()));
		}
	}
	delete(name: string): boolean {
		if (name.startsWith(INDEX) || this.read(name) === undefined) return false;
		this.remove(name);
		const account = this.indexAccount(this.ownerPrefix(name));
		this.write(account, JSON.stringify(parseIndex(this.read(account)).filter((k) => k !== name)));
		return true;
	}
	list(prefix = ""): string[] {
		return parseIndex(this.read(this.indexAccount(prefix)));
	}
}

/**
 * macOS Keychain through `security -i`: commands arrive on stdin, so the key
 * is not visible in `ps`. The value is hex-encoded (-X), which also removes
 * every quoting hazard.
 */
export class MacKeychainBackend extends IndexedBackend {
	readonly name = "keychain" as const;
	constructor(private run: Run = defaultRun) {
		super();
	}
	protected read(account: string): string | undefined {
		const r = this.run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
		const out = r.stdout.trim();
		return r.ok && out ? out : undefined;
	}
	protected write(account: string, value: string): boolean {
		// The account goes into a line read by `security -i`: only a plain, quote-free
		// token may be used, so nothing in an account name can start a second command.
		if (!/^[A-Za-z0-9_.@:/-]+$/.test(account)) throw new Error("keychain account not usable");
		const hex = Buffer.from(value, "utf8").toString("hex");
		const line = `add-generic-password -s ${SERVICE} -a ${account} -X ${hex} -U\n`;
		return this.run("security", ["-i"], line).ok && this.read(account) !== undefined;
	}
	protected remove(account: string): void {
		this.run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
	}
	available(): boolean {
		return this.run("security", ["list-keychains"]).ok;
	}
}

/** libsecret through `secret-tool`; `store` reads the secret from stdin. */
export class LibsecretBackend extends IndexedBackend {
	readonly name = "libsecret" as const;
	constructor(private run: Run = defaultRun) {
		super();
	}
	protected read(account: string): string | undefined {
		const r = this.run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
		return r.ok && r.stdout ? r.stdout : undefined;
	}
	protected write(account: string, value: string): boolean {
		return this.run(
			"secret-tool",
			["store", "--label", `8gent ${account}`, "service", SERVICE, "account", account],
			value,
		).ok;
	}
	protected remove(account: string): void {
		this.run("secret-tool", ["clear", "service", SERVICE, "account", account]);
	}
	available(): boolean {
		return this.run("secret-tool", ["--version"]).ok;
	}
}

/** Fallback: the AES-256-GCM file vault under the data dir. */
export class FileKeyBackend implements KeyBackend {
	readonly name = "file" as const;
	private vault: SecretVault;
	constructor(file: string = defaultVaultPath()) {
		this.vault = new SecretVault(file);
	}
	get(name: string) {
		return this.vault.get(name);
	}
	set(name: string, value: string) {
		this.vault.set(name, value);
	}
	delete(name: string) {
		return this.vault.delete(name);
	}
	list(prefix = "") {
		return this.vault.list().filter((n) => n.startsWith(prefix));
	}
}

function defaultVaultPath(): string {
	const dir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(dir, "vault.enc");
}

// ---------- Selection ----------

let _primary: KeyBackend | null = null;
let _file: FileKeyBackend | null = null;
const cache = new Map<string, string | undefined>();

function fileBackend(): FileKeyBackend {
	return (_file ??= new FileKeyBackend());
}

/**
 * OS keychain when it answers, file vault otherwise. EIGHT_KEY_BACKEND=file
 * forces the file vault (CI, containers, tests).
 */
function primary(): KeyBackend {
	if (_primary) return _primary;
	if (process.env.EIGHT_KEY_BACKEND !== "file") {
		if (process.platform === "darwin") {
			const b = new MacKeychainBackend();
			if (b.available()) return (_primary = b);
		} else if (process.platform === "linux") {
			const b = new LibsecretBackend();
			if (b.available()) return (_primary = b);
		}
	}
	return (_primary = fileBackend());
}

/** Test seam: swap backends and drop the cache. Call with no args to reset. */
export function resetKeyVault(backends?: { primary: KeyBackend; file?: FileKeyBackend }): void {
	_primary = backends?.primary ?? null;
	_file = backends?.file ?? null;
	owner = localOwner();
	cache.clear();
}

export function activeKeyBackend(): KeyBackendName {
	return primary().name;
}

/**
 * Null when the vault is usable. Otherwise a short, neutral sentence for the
 * screen: the file vault exists but could not be read, and was left unchanged.
 */
export function keyVaultProblem(): string | null {
	try {
		primary();
		fileBackend();
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : "The key vault could not be opened.";
	}
}

// ---------- Per-user namespace ----------
//
// Every entry is stored as "<owner>/<name>". The owner is the signed-in user id
// (set by the TUI from packages/auth) or, when signed out, the local OS user.
// Reads, writes, lists and deletes only ever address the current owner's
// prefix, so switching user can never expose or remove another user's keys.

function localOwner(): string {
	let user = "unknown";
	try {
		user = os.userInfo().username;
	} catch {
		/* no passwd entry: keep "unknown" */
	}
	return `os:${user.replace(/[^A-Za-z0-9_.@:-]/g, "_")}`;
}

let owner = localOwner();

function safeOwner(id: string): string {
	return `user:${id.replace(/[^A-Za-z0-9_.@:-]/g, "_")}`;
}

/** Scope the vault to a signed-in user id, or back to the local OS user with null. */
export function setKeyOwner(userId: string | null | undefined): void {
	const next = userId ? safeOwner(userId) : localOwner();
	if (next !== owner) cache.clear();
	owner = next;
}

export function currentKeyOwner(): string {
	return owner;
}

const scoped = (name: string) => `${owner}/${name}`;

// ---------- Public API ----------

/** Vault names are env-var or ref names: letters, digits, underscore, dot, dash. */
export function isValidKeyName(name: string): boolean {
	return /^[A-Za-z0-9_.-]{1,80}$/.test(name) && name !== INDEX;
}

/** Raw key for provider resolution. Undefined when absent or the vault is unreadable. */
export function readVaultKey(name: string): string | undefined {
	if (!isValidKeyName(name)) return undefined;
	const id = scoped(name);
	if (cache.has(id)) return cache.get(id);
	let value: string | undefined;
	try {
		value = primary().get(id);
		if (value === undefined && primary().name !== "file") value = fileBackend().get(id);
	} catch {
		value = undefined;
	}
	cache.set(id, value);
	return value;
}

/** Store a key. Falls back to the file vault if the OS keychain refuses. */
export function storeVaultKey(name: string, value: string): KeyBackendName {
	if (!isValidKeyName(name)) throw new Error("Invalid key name");
	const key = value.trim();
	if (!key) throw new Error("Empty key");
	let used: KeyBackendName = primary().name;
	try {
		primary().set(scoped(name), key);
	} catch {
		fileBackend().set(scoped(name), key);
		used = "file";
	}
	cache.set(scoped(name), key);
	return used;
}

/** Remove a key from every backend that holds it. */
export function deleteVaultKey(name: string): boolean {
	if (!isValidKeyName(name)) return false;
	let removed = false;
	try {
		removed = primary().delete(scoped(name));
		if (primary().name !== "file") removed = fileBackend().delete(scoped(name)) || removed;
	} catch {
		/* a backend is unreadable: nothing is rewritten, the entry stays where it is */
	}
	cache.delete(scoped(name));
	return removed;
}

export interface VaultKeyInfo {
	name: string;
	/** Last four characters only. */
	last4: string;
	backend: KeyBackendName;
}

/** What is stored, safe to render: names and last 4 characters, never the key. */
export function listVaultKeys(): VaultKeyInfo[] {
	const out = new Map<string, VaultKeyInfo>();
	const prefix = `${owner}/`;
	const backends: KeyBackend[] = [];
	try {
		backends.push(primary());
		if (primary().name !== "file") backends.push(fileBackend());
	} catch {
		/* unreadable file vault: list what is readable, keyVaultProblem() explains the rest */
	}
	for (const b of backends) {
		let names: string[] = [];
		try {
			names = b.list(prefix);
		} catch {
			continue;
		}
		for (const id of names) {
			if (!id.startsWith(prefix)) continue; // another user's entry: never read
			const name = id.slice(prefix.length);
			if (out.has(name)) continue;
			const v = b.get(id);
			if (v) out.set(name, { name, last4: last4(v), backend: b.name });
		}
	}
	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function last4(value: string): string {
	return value.length <= 4 ? "*".repeat(value.length) : value.slice(-4);
}

/** Masked rendering for the entry field: one bullet per character, never the characters. */
export function maskKey(value: string): string {
	return "•".repeat(value.length);
}
