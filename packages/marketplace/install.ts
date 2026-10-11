/**
 * 8gent Code - pinned package install (G2).
 *
 *   installPackage("npm:some-ext@1.2.3")
 *
 * resolves the exact version on the npm registry, downloads its tarball,
 * checks it against the registry's `dist.integrity` (sha512 SRI), audits every
 * tar entry (no absolute paths, no "..", no links, nothing outside package/),
 * extracts it to ~/.8gent/packages/<name>@<version>, and pins it in
 * ~/.8gent/packages/8gent-packages.json with that integrity plus a file-level
 * root hash from integrity.ts. A later install of the same name@version must
 * match the pinned integrity or it is refused; verifyPackage() re-hashes the
 * files on disk against the pin.
 *
 * Never runs package scripts, never installs dependencies (they are listed in
 * the result so the caller can say so). The CLI command lives in bin/8gent.ts
 * (lane L3); this module is the engine.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { auditArchiveEntries, extractArchive } from "./archive";
import { buildIntegrity } from "./integrity";

export const LOCK_FILENAME = "8gent-packages.json";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface NpmSource {
	kind: "npm";
	name: string;
	/** Exact version, a range, a dist-tag, or undefined for "latest". */
	version?: string;
}

export interface PinnedPackage {
	name: string;
	version: string;
	source: string;
	/** The registry's sha512 SRI for the tarball, checked on download. */
	integrity: string;
	/** sha256 root hash over every extracted file (integrity.ts). */
	filesRootHash: string;
	tarball: string;
	dir: string;
	installedAt: string;
}

export interface PackageLock {
	version: 1;
	packages: Record<string, PinnedPackage>;
}

export interface InstallOptions {
	/** Install root. Default ~/.8gent/packages. */
	root?: string;
	registry?: string;
	fetch?: typeof fetch;
	/** Largest tarball accepted, bytes. Default 50 MiB. */
	maxBytes?: number;
}

export interface InstallResult {
	pkg: PinnedPackage;
	/** True when this exact pin was already installed and verified; nothing downloaded. */
	alreadyInstalled: boolean;
	/** Declared dependencies, which are NOT installed. */
	dependencies: string[];
	/** The package.json "8gent" field, if any (extensions, prompts, skills). */
	contributes?: unknown;
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function defaultPackagesRoot(): string {
	return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".8gent", "packages");
}

/** Parse "npm:name", "npm:name@1.2.3", "npm:@scope/name@^1". Throws on anything else. */
export function parseSource(spec: string): NpmSource {
	if (!spec.startsWith("npm:")) {
		throw new Error(`unsupported source "${spec}": only npm:<name>[@<version>] is supported`);
	}
	const rest = spec.slice(4);
	const at = rest.lastIndexOf("@");
	const [name, version] = at > 0 ? [rest.slice(0, at), rest.slice(at + 1)] : [rest, undefined];
	if (!NPM_NAME.test(name)) throw new Error(`invalid npm package name "${name}"`);
	if (version !== undefined && !/^[0-9A-Za-z.^~<>=*|+ -]+$/.test(version)) {
		throw new Error(`invalid version "${version}"`);
	}
	return { kind: "npm", name, version: version || undefined };
}

/** Directory name for name@version; a scope's "/" becomes "+". */
export function packageDirName(name: string, version: string): string {
	return `${name.replace("/", "+")}@${version}`;
}

/** sha512 SRI ("sha512-<base64>") of a buffer, the format npm publishes. */
export function sri512(data: Uint8Array): string {
	return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

export function readLock(root: string): PackageLock {
	const file = path.join(root, LOCK_FILENAME);
	if (!fs.existsSync(file)) return { version: 1, packages: {} };
	const lock = JSON.parse(fs.readFileSync(file, "utf-8")) as PackageLock;
	if (lock.version !== 1 || typeof lock.packages !== "object") {
		throw new Error(`${file} is not a version 1 package lock`);
	}
	return lock;
}

function writeLock(root: string, lock: PackageLock): void {
	fs.mkdirSync(root, { recursive: true });
	const file = path.join(root, LOCK_FILENAME);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

interface RegistryVersion {
	version: string;
	dist: { tarball: string; integrity?: string };
	dependencies?: Record<string, string>;
}

/** Resolve a source to one exact published version via the registry document. */
async function resolveVersion(
	src: NpmSource,
	registry: string,
	doFetch: typeof fetch,
): Promise<RegistryVersion> {
	const url = `${registry.replace(/\/$/, "")}/${src.name.replace("/", "%2f")}`;
	const res = await doFetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`registry ${url} answered ${res.status}`);
	const doc = (await res.json()) as {
		"dist-tags"?: Record<string, string>;
		versions?: Record<string, RegistryVersion>;
	};
	const versions = doc.versions ?? {};
	const want = src.version ?? "latest";
	const exact = EXACT.test(want) ? want : doc["dist-tags"]?.[want];
	if (!exact) {
		throw new Error(
			`"${want}" is not an exact version or a dist-tag of ${src.name}; pin one, e.g. npm:${src.name}@${doc["dist-tags"]?.latest ?? "1.0.0"}`,
		);
	}
	const v = versions[exact];
	if (!v) throw new Error(`${src.name}@${exact} is not published`);
	return v;
}

/** Reject links and anything that is not a plain file or directory. */
function auditEntryTypes(tarball: string): string[] {
	const res = spawnSync("tar", ["-tvzf", path.basename(tarball)], {
		encoding: "utf-8",
		cwd: path.dirname(tarball),
	});
	if (res.status !== 0) return [`tar -tvzf failed: ${res.stderr}`];
	const errors: string[] = [];
	for (const line of res.stdout.split("\n").filter(Boolean)) {
		const type = line[0];
		if (type !== "-" && type !== "d") errors.push(`not a plain file or directory: ${line}`);
	}
	return errors;
}

/**
 * Install one npm package, pinned by integrity. Idempotent: the same pin
 * already on disk and still matching is a no-op. A pin whose integrity does
 * not match what the registry serves now is refused, never overwritten.
 */
export async function installPackage(
	spec: string,
	opts: InstallOptions = {},
): Promise<InstallResult> {
	const src = parseSource(spec);
	const root = opts.root ?? defaultPackagesRoot();
	const doFetch = opts.fetch ?? fetch;
	const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
	const lock = readLock(root);

	const meta = await resolveVersion(src, opts.registry ?? DEFAULT_REGISTRY, doFetch);
	const expected = meta.dist.integrity;
	if (!expected?.startsWith("sha512-")) {
		throw new Error(
			`${src.name}@${meta.version} has no sha512 integrity on the registry; refusing to install`,
		);
	}
	const key = src.name;
	const pinned = lock.packages[key];
	if (pinned && pinned.version === meta.version) {
		if (pinned.integrity !== expected) {
			throw new Error(
				`${key}@${meta.version} is pinned to ${pinned.integrity} but the registry now serves ${expected}; refusing`,
			);
		}
		const check = verifyPackage(key, { root });
		if (check.ok) {
			return {
				pkg: pinned,
				alreadyInstalled: true,
				dependencies: Object.keys(meta.dependencies ?? {}),
			};
		}
	}

	const res = await doFetch(meta.dist.tarball);
	if (!res.ok) throw new Error(`tarball ${meta.dist.tarball} answered ${res.status}`);
	const data = new Uint8Array(await res.arrayBuffer());
	if (data.byteLength > maxBytes)
		throw new Error(`tarball is ${data.byteLength} bytes, over ${maxBytes}`);
	const got = sri512(data);
	if (got !== expected) {
		throw new Error(
			`integrity mismatch for ${key}@${meta.version}: expected ${expected}, got ${got}`,
		);
	}

	fs.mkdirSync(root, { recursive: true });
	const staging = fs.mkdtempSync(path.join(root, ".staging-"));
	try {
		const tarball = path.join(staging, "package.tgz");
		fs.writeFileSync(tarball, data);
		const errors = [...auditArchiveEntries(tarball, "package").errors, ...auditEntryTypes(tarball)];
		if (errors.length > 0) throw new Error(`refusing ${key}@${meta.version}: ${errors.join("; ")}`);
		const out = path.join(staging, "out");
		extractArchive(tarball, out);
		const pkgDir = path.join(out, "package");
		const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as {
			name?: string;
			version?: string;
			"8gent"?: unknown;
		};
		if (manifest.name !== key || manifest.version !== meta.version) {
			throw new Error(
				`tarball says ${manifest.name}@${manifest.version}, expected ${key}@${meta.version}`,
			);
		}
		const dir = path.join(root, packageDirName(key, meta.version));
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(pkgDir, dir);
		const pkg: PinnedPackage = {
			name: key,
			version: meta.version,
			source: `npm:${key}@${meta.version}`,
			integrity: expected,
			filesRootHash: buildIntegrity(dir).rootHash,
			tarball: meta.dist.tarball,
			dir,
			installedAt: new Date().toISOString(),
		};
		// A different version of the same name is replaced; its folder goes too.
		if (pinned && pinned.dir !== dir) fs.rmSync(pinned.dir, { recursive: true, force: true });
		lock.packages[key] = pkg;
		writeLock(root, lock);
		return {
			pkg,
			alreadyInstalled: false,
			dependencies: Object.keys(meta.dependencies ?? {}),
			contributes: manifest["8gent"],
		};
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Pinned packages, sorted by name. */
export function listPackages(opts: { root?: string } = {}): PinnedPackage[] {
	const lock = readLock(opts.root ?? defaultPackagesRoot());
	return Object.values(lock.packages).sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a package and its pin. False when it was not installed. */
export function removePackage(name: string, opts: { root?: string } = {}): boolean {
	const root = opts.root ?? defaultPackagesRoot();
	const lock = readLock(root);
	const pinned = lock.packages[name];
	if (!pinned) return false;
	// Only ever delete inside the packages root.
	const rel = path.relative(path.resolve(root), path.resolve(pinned.dir));
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		fs.rmSync(pinned.dir, { recursive: true, force: true });
	}
	delete lock.packages[name];
	writeLock(root, lock);
	return true;
}

/** Re-hash an installed package's files against its pin. */
export function verifyPackage(
	name: string,
	opts: { root?: string } = {},
): { ok: boolean; error?: string } {
	const lock = readLock(opts.root ?? defaultPackagesRoot());
	const pinned = lock.packages[name];
	if (!pinned) return { ok: false, error: `${name} is not installed` };
	if (!fs.existsSync(pinned.dir)) return { ok: false, error: `${pinned.dir} is missing` };
	const now = buildIntegrity(pinned.dir);
	if (now.rootHash !== pinned.filesRootHash) {
		return { ok: false, error: `${name}@${pinned.version} files changed since install` };
	}
	return { ok: true };
}
