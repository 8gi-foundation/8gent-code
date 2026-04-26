/**
 * LibsecretVault - Linux libsecret backend for secrets.
 *
 * Wraps the `secret-tool` CLI (libsecret-tools package) to store/retrieve
 * secrets via the Secret Service API (gnome-keyring or kwallet). Same public
 * shape as KeychainVault so platform-aware code can pick by `process.platform`
 * without changing call sites.
 *
 * Required on Hetzner / production Linux for OAuth refresh tokens and email
 * account credentials. Use SecretVault on Linux only as a fallback when
 * libsecret is unavailable.
 */

const DEFAULT_SERVICE = "8gent-secrets";
const INDEX_KEY = "__index__";

export interface LibsecretVaultOptions {
	service?: string;
}

export class LibsecretVault {
	private service: string;

	constructor(opts: LibsecretVaultOptions = {}) {
		this.service = opts.service ?? DEFAULT_SERVICE;
		if (process.platform !== "linux") {
			throw new Error(
				"LibsecretVault requires Linux. Use KeychainVault on macOS, SecretVault elsewhere.",
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

	async useSecret<T>(key: string, callback: (value: string) => Promise<T>): Promise<T> {
		const value = await this.get(key);
		if (value === undefined) {
			throw new Error(`Secret "${key}" not found in libsecret`);
		}
		return callback(value);
	}

	// ---------- Private ----------

	private async writeEntry(account: string, value: string): Promise<void> {
		await this.deleteEntry(account).catch(() => {});

		const proc = Bun.spawn(
			[
				"secret-tool",
				"store",
				"--label",
				`8gent-secrets:${account}`,
				"service",
				this.service,
				"account",
				account,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		proc.stdin.write(value);
		proc.stdin.end();

		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			throw new Error(`libsecret write failed for "${account}": ${stderr.trim()}`);
		}
	}

	private async readEntry(account: string): Promise<string | undefined> {
		const result = await this.runSecretTool([
			"lookup",
			"service",
			this.service,
			"account",
			account,
		]);
		if (!result.success) return undefined;
		const value = result.stdout;
		return value.length > 0 ? value : undefined;
	}

	private async deleteEntry(account: string): Promise<void> {
		await this.runSecretTool(["clear", "service", this.service, "account", account]);
	}

	private async readIndex(): Promise<string[]> {
		const raw = await this.readEntry(INDEX_KEY);
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
		} catch {
			return [];
		}
	}

	private async runSecretTool(
		args: string[],
	): Promise<{ success: boolean; stdout: string; stderr: string }> {
		try {
			const proc = Bun.spawn(["secret-tool", ...args], {
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

let _libsecret: LibsecretVault | null = null;

export function getLibsecretVault(): LibsecretVault {
	if (!_libsecret) {
		_libsecret = new LibsecretVault();
	}
	return _libsecret;
}

/**
 * Platform-aware OS vault factory. Picks Keychain on macOS, libsecret on
 * Linux, throws elsewhere. Callers wanting a fallback to file-based
 * SecretVault should catch and retry with getVault().
 */
export async function getOSVault() {
	if (process.platform === "darwin") {
		const { getKeychainVault } = await import("./keychain");
		return getKeychainVault();
	}
	if (process.platform === "linux") {
		return getLibsecretVault();
	}
	throw new Error(`No OS vault available for platform "${process.platform}". Use SecretVault.`);
}
