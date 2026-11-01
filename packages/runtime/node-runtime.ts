/**
 * @8gent/runtime — node-runtime.ts
 *
 * Manages a private Node 22 runtime under `~/.8gent/runtime/node-22.x.x/`
 * so 8gent and any /spawn'd CLI that requires a newer Node than the
 * user has on their system can still work. No system-level changes,
 * no nvm dependency, no sudo.
 *
 * Public surface:
 *   - parseNodeVersion(out)        — pure: parse `node --version` output
 *   - satisfiesMinVersion(v, min)  — pure: SemVer-ish gte check
 *   - pickPlatformAsset({platform,arch}) — pure: choose the right asset
 *   - buildDownloadUrl({version,asset})  — pure: nodejs.org URL builder
 *   - getRuntimeDir({root,version})       — path to the extracted dir
 *   - resolvedNodeBinPath({root,version,platform}) — `<dir>/bin/node` etc.
 *   - isRuntimeReady({root,version,platform,minVersion}) — bool
 *
 * The actual download + extract path lives in `installer.ts` so the
 * pure logic above can be unit-tested without network or tar deps.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export interface NodeVersion {
	major: number;
	minor: number;
	patch: number;
}

export type Platform = "darwin" | "linux" | "win32";
export type Arch = "arm64" | "x64";

export interface PlatformAsset {
	os: "darwin" | "linux" | "win";
	arch: Arch;
	ext: "tar.gz" | "tar.xz" | "zip";
}

export interface RuntimeLocator {
	/** Override the root install dir. Defaults to ~/.8gent/runtime. */
	root?: string;
	/** Pinned Node version, e.g. "22.12.0". */
	version: string;
}

export interface RuntimeReadyOpts extends RuntimeLocator {
	/** OS family. Defaults to current process.platform. */
	platform?: NodeJS.Platform;
	/** Minimum acceptable version (SemVer-ish). Default = the pinned version. */
	minVersion?: string;
}

// ============================================================================
// Pure parsing
// ============================================================================

export function parseNodeVersion(raw: string): NodeVersion | null {
	const trimmed = raw.trim();
	const match = trimmed.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
	};
}

export function satisfiesMinVersion(v: NodeVersion, min: string): boolean {
	const minParsed = parseNodeVersion(min);
	if (!minParsed) return true;
	if (v.major !== minParsed.major) return v.major > minParsed.major;
	if (v.minor !== minParsed.minor) return v.minor > minParsed.minor;
	return v.patch >= minParsed.patch;
}

// ============================================================================
// Platform asset selection
// ============================================================================

const SUPPORTED: Record<string, Record<string, PlatformAsset>> = {
	darwin: {
		arm64: { os: "darwin", arch: "arm64", ext: "tar.gz" },
		x64: { os: "darwin", arch: "x64", ext: "tar.gz" },
	},
	linux: {
		arm64: { os: "linux", arch: "arm64", ext: "tar.xz" },
		x64: { os: "linux", arch: "x64", ext: "tar.xz" },
	},
	win32: {
		x64: { os: "win", arch: "x64", ext: "zip" },
		arm64: { os: "win", arch: "arm64", ext: "zip" },
	},
};

export function pickPlatformAsset(input: {
	platform: NodeJS.Platform;
	arch: string;
}): PlatformAsset {
	const byArch = SUPPORTED[input.platform];
	if (!byArch) {
		throw new Error(`unsupported platform: ${input.platform}`);
	}
	const asset = byArch[input.arch];
	if (!asset) {
		throw new Error(
			`unsupported arch: ${input.arch} on ${input.platform}`,
		);
	}
	return asset;
}

// ============================================================================
// Download URL
// ============================================================================

export function buildDownloadUrl(opts: {
	version: string;
	asset: PlatformAsset;
}): string {
	const cleanVersion = opts.version.startsWith("v") ? opts.version.slice(1) : opts.version;
	const v = `v${cleanVersion}`;
	const fileBase = `node-${v}-${opts.asset.os}-${opts.asset.arch}`;
	return `https://nodejs.org/dist/${v}/${fileBase}.${opts.asset.ext}`;
}

// ============================================================================
// Runtime location
// ============================================================================

function defaultRoot(): string {
	return join(homedir(), ".8gent", "runtime");
}

export function getRuntimeDir(loc: RuntimeLocator): string {
	const root = loc.root ?? defaultRoot();
	return join(root, `node-${loc.version}`);
}

export function resolvedNodeBinPath(opts: {
	root?: string;
	version: string;
	platform: NodeJS.Platform;
}): string {
	const dir = getRuntimeDir(opts);
	if (opts.platform === "win32") {
		return join(dir, "node.exe");
	}
	return join(dir, "bin", "node");
}

// ============================================================================
// Readiness check (filesystem + spawn)
// ============================================================================

export async function isRuntimeReady(opts: RuntimeReadyOpts): Promise<boolean> {
	const platform = opts.platform ?? (process.platform as NodeJS.Platform);
	const bin = resolvedNodeBinPath({
		root: opts.root,
		version: opts.version,
		platform,
	});
	if (!existsSync(bin)) return false;
	const min = opts.minVersion ?? opts.version;
	try {
		const { stdout } = await execFileAsync(bin, ["--version"], {
			timeout: 3000,
		});
		const parsed = parseNodeVersion(stdout);
		if (!parsed) return false;
		return satisfiesMinVersion(parsed, min);
	} catch {
		return false;
	}
}
