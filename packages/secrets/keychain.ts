/**
 * KeychainVault - macOS Keychain backend for secrets.
 *
 * Same public API shape as SecretVault but async, since the macOS `security`
 * CLI is a subprocess. Use this for high-value tokens (OAuth refresh tokens,
 * email account credentials) where OS-managed encryption matters.
 *
 * For low-value or batch-loaded secrets (like .env migration), SecretVault is
 * fine and faster.
 */

const DEFAULT_SERVICE = "8gent-secrets";
const INDEX_KEY = "__index__";

export interface KeychainVaultOptions {
	service?: string;
}

export class KeychainVault {
	private service: string;

	constructor(opts: KeychainVaultOptions = {}) {
		this.service = opts.service ?? DEFAULT_SERVICE;
		if (process.platform !== "darwin") {
			throw new Error(
				"KeychainVault requires macOS. Use SecretVault on other platforms.",
			);
		}
	}

	async set(key: string, value: string): Promise<void> {
		if (key === INDEX_KEY) throw new Error(`Reserved key: ${INDEX_KEY}`);
		await this.writeEntry(key, value);
		const index = await this.readIndex();
		if (!index.includes(key)) {
			index.push(key);
			await this.writeEntry(INDEX_KEY, JSON.stringify(index.sort()));
		}
	}

	async get(key: string): Promise<string | undefined> {
		if (key === INDEX_KEY) return undefined;
		return this.readEntry(key);
	}

	async has(key: string): Promise<boolean> {
		return (await this.readEntry(key)) !== undefined;
	}

	async list(): Promise<string[]> {
		return this.readIndex();
	}

	async delete(key: string): Promise<boolean> {
		if (key === INDEX_KEY) return false;
		const existed = await this.has(key);
		if (!existed) return false;
		await this.deleteEntry(key);
		const index = await this.readIndex();
		const next = index.filter((k) => k !== key);
		await this.writeEntry(INDEX_KEY, JSON.stringify(next));
		return true;
	}

	/**
	 * Use a secret without exposing it to the LLM. The raw value is passed to
	 * the callback but never returned to the caller as a string. Mirrors
	 * SecretVault.useSecret for callsite compatibility.
	 */
	async useSecret<T>(
		key: string,
		callback: (value: string) => Promise<T>,
	): Promise<T> {
		const value = await this.get(key);
		if (value === undefined) {
			throw new Error(`Secret "${key}" not found in keychain`);
		}
		return callback(value);
	}

	// ---------- Private ----------

	private async writeEntry(account: string, value: string): Promise<void> {
		await this.runSecurity([
			"delete-generic-password",
			"-s",
			this.service,
			"-a",
			account,
		]).catch(() => {});

		const result = await this.runSecurity([
			"add-generic-password",
			"-s",
			this.service,
			"-a",
			account,
			"-w",
			value,
			"-U",
		]);

		if (!result.success) {
			throw new Error(
				`Keychain write failed for "${account}": ${result.stderr.trim()}`,
			);
		}
	}

	private async readEntry(account: string): Promise<string | undefined> {
		const result = await this.runSecurity([
			"find-generic-password",
			"-s",
			this.service,
			"-a",
			account,
			"-w",
		]);
		if (!result.success) return undefined;
		const trimmed = result.stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	private async deleteEntry(account: string): Promise<void> {
		await this.runSecurity([
			"delete-generic-password",
			"-s",
			this.service,
			"-a",
			account,
		]);
	}

	private async readIndex(): Promise<string[]> {
		const raw = await this.readEntry(INDEX_KEY);
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter((k) => typeof k === "string")
				: [];
		} catch {
			return [];
		}
	}

	private async runSecurity(
		args: string[],
	): Promise<{ success: boolean; stdout: string; stderr: string }> {
		try {
			const proc = Bun.spawn(["security", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			return { success: exitCode === 0, stdout, stderr };
		} catch (error) {
			return {
				success: false,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

let _keychain: KeychainVault | null = null;

export function getKeychainVault(): KeychainVault {
	if (!_keychain) {
		_keychain = new KeychainVault();
	}
	return _keychain;
}
