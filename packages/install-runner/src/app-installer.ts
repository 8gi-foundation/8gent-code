/**
 * @8gent/install-runner — app-installer.ts
 *
 * Installer for 8gent apps (separate from the harness preset installer
 * in ../install-runner.ts). An app is a versioned bundle distributed as
 * a .tar.gz archive with a manifest at its root (`app.json`).
 *
 * Responsibilities:
 *   - Fetch (URL or local path) → integrity-verify → extract → register
 *   - Sandbox: reject archive entries that escape the install dir
 *   - Lifecycle: enable / disable / update / uninstall, persisted in
 *     the registry SQLite so state survives agent restarts
 *   - Capability resolution: required capabilities checked against the
 *     host's available set before any files are written
 *   - Rollback: every install runs through a staging dir that is
 *     atomically renamed on success and rm'd on any failure
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getInstalledApp,
	listInstalledApps,
	registerInstalledApp,
	setAppEnabled,
	unregisterInstalledApp,
} from "../../registry/index.js";

// ============================================================================
// Types
// ============================================================================

export interface AppManifest {
	name: string;
	version: string;
	entry: string;
	capabilities?: string[];
	description?: string;
	homepage?: string;
}

export interface InstalledApp {
	name: string;
	version: string;
	installPath: string;
	enabled: boolean;
	manifest: AppManifest;
	installedAt: string;
}

export interface InstallAppOptions {
	/** Expected SHA-256 of the archive bytes. Hex, lowercase. */
	sha256?: string;
	/** Allowed hosts when source is a URL. Defaults to undefined = deny. */
	allowedHosts?: string[];
	/** Capabilities this host can grant the app. Manifest requires must be a subset. */
	availableCapabilities?: string[];
	/** Where to put apps. Defaults to ~/.8gent/apps. */
	appsDir?: string;
}

export class InstallAppError extends Error {
	constructor(
		message: string,
		public code: string,
	) {
		super(message);
		this.name = "InstallAppError";
	}
}

// ============================================================================
// Paths
// ============================================================================

export function defaultAppsDir(): string {
	return process.env.EIGHTGENT_APPS_DIR || path.join(os.homedir(), ".8gent", "apps");
}

function stagingDir(appsDir: string): string {
	return path.join(appsDir, ".staging");
}

// ============================================================================
// installApp
// ============================================================================

export async function installApp(
	source: string,
	opts: InstallAppOptions = {},
): Promise<InstalledApp> {
	const appsDir = opts.appsDir ?? defaultAppsDir();
	fs.mkdirSync(appsDir, { recursive: true });
	fs.mkdirSync(stagingDir(appsDir), { recursive: true });

	const stagingId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
	const stagingPath = path.join(stagingDir(appsDir), stagingId);
	const archivePath = path.join(stagingPath, "archive.tgz");
	fs.mkdirSync(stagingPath, { recursive: true });

	try {
		await fetchArchive(source, archivePath, opts);
		verifyIntegrity(archivePath, opts.sha256);

		const extractDir = path.join(stagingPath, "extract");
		fs.mkdirSync(extractDir, { recursive: true });
		await extractTarGz(archivePath, extractDir);

		const manifest = readManifest(extractDir);
		validateCapabilities(manifest, opts.availableCapabilities);

		const finalPath = path.join(appsDir, manifest.name, manifest.version);
		const existing = getInstalledApp(manifest.name);
		if (existing && existing.version === manifest.version) {
			throw new InstallAppError(
				`${manifest.name}@${manifest.version} is already installed`,
				"ALREADY_INSTALLED",
			);
		}

		fs.mkdirSync(path.dirname(finalPath), { recursive: true });
		if (fs.existsSync(finalPath)) {
			fs.rmSync(finalPath, { recursive: true, force: true });
		}
		fs.renameSync(extractDir, finalPath);

		const installed: InstalledApp = {
			name: manifest.name,
			version: manifest.version,
			installPath: finalPath,
			enabled: true,
			manifest,
			installedAt: new Date().toISOString(),
		};

		registerInstalledApp({
			name: installed.name,
			version: installed.version,
			installPath: installed.installPath,
			enabled: installed.enabled ? 1 : 0,
			manifest: JSON.stringify(installed.manifest),
			installedAt: installed.installedAt,
		});

		return installed;
	} finally {
		fs.rmSync(stagingPath, { recursive: true, force: true });
	}
}

// ============================================================================
// Fetch (URL or local path)
// ============================================================================

async function fetchArchive(source: string, dest: string, opts: InstallAppOptions): Promise<void> {
	if (isUrl(source)) {
		const url = new URL(source);
		const allowed = opts.allowedHosts ?? [];
		if (!allowed.includes(url.host)) {
			throw new InstallAppError(`host ${url.host} not in allowedHosts`, "HOST_NOT_ALLOWED");
		}
		const res = await fetch(source);
		if (!res.ok) {
			throw new InstallAppError(`fetch failed: ${res.status} ${res.statusText}`, "FETCH_FAILED");
		}
		const buf = Buffer.from(await res.arrayBuffer());
		fs.writeFileSync(dest, buf);
		return;
	}

	if (!fs.existsSync(source)) {
		throw new InstallAppError(`archive not found: ${source}`, "NOT_FOUND");
	}
	fs.copyFileSync(source, dest);
}

function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

// ============================================================================
// Integrity
// ============================================================================

function verifyIntegrity(archivePath: string, expected?: string): void {
	if (!expected) return;
	const buf = fs.readFileSync(archivePath);
	const actual = crypto.createHash("sha256").update(buf).digest("hex");
	if (actual.toLowerCase() !== expected.toLowerCase()) {
		throw new InstallAppError(
			`integrity check failed: expected ${expected}, got ${actual}`,
			"INTEGRITY_FAILED",
		);
	}
}

// ============================================================================
// Extract — tar.gz, with sandbox enforcement (zip-slip / abs-path rejection)
// ============================================================================

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	const entries = await listTarEntries(archivePath);
	const resolvedDest = path.resolve(destDir);
	for (const entry of entries) {
		if (path.isAbsolute(entry)) {
			throw new InstallAppError(`unsafe archive entry (absolute path): ${entry}`, "UNSAFE_ENTRY");
		}
		const resolved = path.resolve(destDir, entry);
		if (resolved !== resolvedDest && !resolved.startsWith(`${resolvedDest}${path.sep}`)) {
			throw new InstallAppError(`unsafe archive entry (escapes sandbox): ${entry}`, "UNSAFE_ENTRY");
		}
	}
	await runTar(["-xzf", archivePath, "-C", destDir]);
}

function listTarEntries(archivePath: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const proc = spawn("tar", ["-tzf", archivePath]);
		const out: Buffer[] = [];
		const errBuf: Buffer[] = [];
		proc.stdout.on("data", (d) => out.push(d));
		proc.stderr.on("data", (d) => errBuf.push(d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(
					new InstallAppError(`tar -tzf failed: ${Buffer.concat(errBuf).toString()}`, "TAR_FAILED"),
				);
				return;
			}
			resolve(
				Buffer.concat(out)
					.toString()
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean),
			);
		});
	});
}

function runTar(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn("tar", args);
		const errBuf: Buffer[] = [];
		proc.stderr.on("data", (d) => errBuf.push(d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(
					new InstallAppError(
						`tar ${args[0]} failed: ${Buffer.concat(errBuf).toString()}`,
						"TAR_FAILED",
					),
				);
				return;
			}
			resolve();
		});
	});
}

// ============================================================================
// Manifest
// ============================================================================

function readManifest(extractDir: string): AppManifest {
	const direct = path.join(extractDir, "app.json");
	let manifestPath = direct;
	if (!fs.existsSync(direct)) {
		const entries = fs.readdirSync(extractDir);
		const single = entries.length === 1 ? entries[0] : null;
		if (single) {
			const nested = path.join(extractDir, single, "app.json");
			if (fs.existsSync(nested)) {
				manifestPath = nested;
				flattenSingleRoot(extractDir, single);
			}
		}
	}
	if (!fs.existsSync(manifestPath)) {
		throw new InstallAppError("app.json not found in archive root", "NO_MANIFEST");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (e) {
		throw new InstallAppError(`invalid app.json: ${(e as Error).message}`, "BAD_MANIFEST");
	}
	const m = parsed as Partial<AppManifest>;
	if (!m || typeof m !== "object") {
		throw new InstallAppError("app.json must be an object", "BAD_MANIFEST");
	}
	if (!m.name || !m.version || !m.entry) {
		throw new InstallAppError(
			"app.json missing required fields (name, version, entry)",
			"BAD_MANIFEST",
		);
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(m.name)) {
		throw new InstallAppError(`invalid app name: ${m.name}`, "BAD_MANIFEST");
	}
	return {
		name: m.name,
		version: m.version,
		entry: m.entry,
		capabilities: m.capabilities ?? [],
		description: m.description,
		homepage: m.homepage,
	};
}

function flattenSingleRoot(extractDir: string, rootName: string): void {
	const root = path.join(extractDir, rootName);
	for (const entry of fs.readdirSync(root)) {
		fs.renameSync(path.join(root, entry), path.join(extractDir, entry));
	}
	fs.rmdirSync(root);
}

// ============================================================================
// Capability resolution
// ============================================================================

function validateCapabilities(manifest: AppManifest, available: string[] | undefined): void {
	const required = manifest.capabilities ?? [];
	if (required.length === 0) return;
	if (!available) {
		throw new InstallAppError(
			`app requires capabilities (${required.join(", ")}) but host did not declare any`,
			"MISSING_CAPABILITIES",
		);
	}
	const missing = required.filter((c) => !available.includes(c));
	if (missing.length > 0) {
		throw new InstallAppError(
			`missing capabilities: ${missing.join(", ")}`,
			"MISSING_CAPABILITIES",
		);
	}
}

// ============================================================================
// Lifecycle
// ============================================================================

export function enableApp(name: string): InstalledApp {
	const row = getInstalledApp(name);
	if (!row) throw new InstallAppError(`app not installed: ${name}`, "NOT_INSTALLED");
	setAppEnabled(name, 1);
	return rowToApp({ ...row, enabled: 1 });
}

export function disableApp(name: string): InstalledApp {
	const row = getInstalledApp(name);
	if (!row) throw new InstallAppError(`app not installed: ${name}`, "NOT_INSTALLED");
	setAppEnabled(name, 0);
	return rowToApp({ ...row, enabled: 0 });
}

export async function updateApp(
	name: string,
	source: string,
	opts: InstallAppOptions = {},
): Promise<InstalledApp> {
	const existing = getInstalledApp(name);
	if (!existing) {
		throw new InstallAppError(`app not installed: ${name}`, "NOT_INSTALLED");
	}
	await uninstallApp(name, { keepRegistration: false, appsDir: opts.appsDir });
	return installApp(source, opts);
}

export async function uninstallApp(
	name: string,
	opts: { keepRegistration?: boolean; appsDir?: string } = {},
): Promise<void> {
	const row = getInstalledApp(name);
	if (!row) throw new InstallAppError(`app not installed: ${name}`, "NOT_INSTALLED");
	if (fs.existsSync(row.installPath)) {
		fs.rmSync(row.installPath, { recursive: true, force: true });
	}
	const appsDir = opts.appsDir ?? defaultAppsDir();
	const nameDir = path.join(appsDir, name);
	if (fs.existsSync(nameDir) && fs.readdirSync(nameDir).length === 0) {
		fs.rmdirSync(nameDir);
	}
	if (!opts.keepRegistration) {
		unregisterInstalledApp(name);
	}
}

export function listApps(): InstalledApp[] {
	return listInstalledApps().map(rowToApp);
}

export function getApp(name: string): InstalledApp | null {
	const row = getInstalledApp(name);
	return row ? rowToApp(row) : null;
}

function rowToApp(row: {
	name: string;
	version: string;
	installPath: string;
	enabled: number;
	manifest: string;
	installedAt: string;
}): InstalledApp {
	return {
		name: row.name,
		version: row.version,
		installPath: row.installPath,
		enabled: row.enabled === 1,
		manifest: JSON.parse(row.manifest),
		installedAt: row.installedAt,
	};
}
