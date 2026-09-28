/**
 * The async shape shared by every OS-backed vault (macOS Keychain, Linux
 * libsecret, Windows DPAPI), so callers can pick one by platform without
 * changing call sites.
 */

import { getDpapiVault } from "./dpapi";
import { getKeychainVault } from "./keychain";
import { getLibsecretVault } from "./libsecret";

export interface OSVault {
	set(key: string, value: string): Promise<void>;
	get(key: string): Promise<string | undefined>;
	has(key: string): Promise<boolean>;
	/** Stored keys, sorted. */
	list(): Promise<string[]>;
	delete(key: string): Promise<boolean>;
	useSecret<T>(key: string, callback: (value: string) => Promise<T>): Promise<T>;
}

/**
 * Callers wanting a fallback to the file-based SecretVault should catch and
 * retry with getVault().
 */
export async function getOSVault(platform: NodeJS.Platform = process.platform): Promise<OSVault> {
	if (platform === "darwin") return getKeychainVault();
	if (platform === "linux") return getLibsecretVault();
	if (platform === "win32") return getDpapiVault();
	throw new Error(`No OS vault available for platform "${platform}". Use SecretVault.`);
}
