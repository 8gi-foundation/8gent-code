/**
 * DpapiVault - Windows backend for secrets.
 *
 * Each secret is sealed with DPAPI (CurrentUser scope) and stored as its own
 * file under ~/.8gent/vault-dpapi/<service>. Only the same Windows user on the
 * same machine can unseal it. DPAPI is reached through powershell.exe because
 * Credential Manager would need runtime C# compilation (slow, blocked under
 * Constrained Language Mode) and caps blobs at 2560 bytes.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "../core/home";
import type { OSVault } from "./os-vault";

const DEFAULT_SERVICE = "8gent-secrets";
const INDEX_KEY = "__index__";
const EXTENSION = ".dpapi";

export interface DpapiCipher {
	protect(plain: Uint8Array): Promise<Uint8Array>;
	unprotect(sealed: Uint8Array): Promise<Uint8Array>;
}

export interface DpapiVaultOptions {
	service?: string;
	dir?: string;
	cipher?: DpapiCipher;
}

export class DpapiVault implements OSVault {
	private dir: string;
	private cipher: DpapiCipher;

	constructor(opts: DpapiVaultOptions = {}) {
		if (!opts.cipher && process.platform !== "win32") {
			throw new Error(
				"DpapiVault requires Windows. Use KeychainVault on macOS, LibsecretVault on Linux.",
			);
		}
		const service = opts.service ?? DEFAULT_SERVICE;
		this.dir = opts.dir ?? join(resolveHome(), ".8gent", "vault-dpapi", service);
		this.cipher = opts.cipher ?? powershellDpapiCipher;
	}

	async set(key: string, value: string): Promise<void> {
		if (key === INDEX_KEY) throw new Error(`Reserved key: ${INDEX_KEY}`);
		await mkdir(this.dir, { recursive: true });
		const sealed = await this.cipher.protect(new TextEncoder().encode(value));
		const target = this.pathFor(key);
		const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, sealed);
		await rename(temp, target);
	}

	async get(key: string): Promise<string | undefined> {
		if (key === INDEX_KEY) return undefined;
		let sealed: Uint8Array;
		try {
			sealed = await readFile(this.pathFor(key));
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		return new TextDecoder().decode(await this.cipher.unprotect(sealed));
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== undefined;
	}

	async list(): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		return names
			.filter((name) => name.endsWith(EXTENSION))
			.map((name) => Buffer.from(name.slice(0, -EXTENSION.length), "hex").toString("utf8"))
			.sort();
	}

	async delete(key: string): Promise<boolean> {
		if (key === INDEX_KEY) return false;
		try {
			await unlink(this.pathFor(key));
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	async useSecret<T>(key: string, callback: (value: string) => Promise<T>): Promise<T> {
		const value = await this.get(key);
		if (value === undefined) {
			throw new Error(`Secret "${key}" not found in DPAPI vault`);
		}
		return callback(value);
	}

	// Hex names because Windows filesystems are case-insensitive ("Token" and
	// "TOKEN" would collide) and keys may hold characters illegal in filenames.
	private pathFor(key: string): string {
		return join(this.dir, `${Buffer.from(key, "utf8").toString("hex")}${EXTENSION}`);
	}
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function dpapiScript(method: "Protect" | "Unprotect"): string {
	return [
		"$ErrorActionPreference='Stop'",
		"Add-Type -AssemblyName System.Security",
		"$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
		`$out=[System.Security.Cryptography.ProtectedData]::${method}($in,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
		"[Console]::Out.Write([Convert]::ToBase64String($out))",
	].join("; ");
}

// Base64 both ways because Windows PowerShell reads stdin and writes stdout in
// the OEM code page, which mangles non-ASCII bytes. The secret travels only
// over stdin, never in the command line.
async function runDpapi(method: "Protect" | "Unprotect", payload: Uint8Array): Promise<Uint8Array> {
	const proc = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			encodePowerShellCommand(dpapiScript(method)),
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	proc.stdin.write(`${Buffer.from(payload).toString("base64")}\n`);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const encoded = stdout.trim();
	if (exitCode !== 0 || encoded.length === 0) {
		throw new Error(`DPAPI ${method} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return new Uint8Array(Buffer.from(encoded, "base64"));
}

export const powershellDpapiCipher: DpapiCipher = {
	protect: (plain) => runDpapi("Protect", plain),
	unprotect: (sealed) => runDpapi("Unprotect", sealed),
};

let _dpapi: DpapiVault | null = null;

export function getDpapiVault(): DpapiVault {
	if (!_dpapi) {
		_dpapi = new DpapiVault();
	}
	return _dpapi;
}
