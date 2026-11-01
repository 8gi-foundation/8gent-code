/**
 * 8gent Code - pinned package install (G2).
 *
 *   installPackage("npm:some-ext@1.2.3")
 *
 * resolves the exact version on an https npm registry, downloads its tarball
 * (https, same host as the registry, no redirects, size-capped while it
 * streams), checks it against the registry's `dist.integrity` (sha512 SRI),
 * reads every tar header in process before writing anything (npm-tar.ts: no
 * links, no "..", nothing outside package/, no case collisions, entry and size
 * caps), extracts it to ~/.8gent/packages/<name>@<version>, and pins it in
 * ~/.8gent/packages/8gent-packages.json with that integrity plus a file-level
 * root hash from integrity.ts. A later install of the same name@version must
 * match the pinned integrity or it is refused; verifyPackage() re-hashes the
 * files on disk against the pin.
 *
 * Never runs package scripts, never installs dependencies (they are listed in
 * the result so the caller can say so). The CLI command lives in bin/8gent.ts
 * (lane L3); this module is the engine.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIntegrity } from "./integrity";
import { readNpmTarball, writeEntries } from "./npm-tar";

export const LOCK_FILENAME = "8gent-packages.json";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** Largest registry document read. */
export const MAX_REGISTRY_JSON = 32 * 1024 * 1024;
/** A package first published less than this long ago gets a note. */
export const NEW_PACKAGE_DAYS = 30;

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
	/** https registry base. Default https://registry.npmjs.org. */
	registry?: string;
	fetch?: typeof fetch;
	/** Largest tarball accepted, bytes. Default 50 MiB. */
	maxBytes?: number;
	/** Tests only: accept an http registry on 127.0.0.1 / localhost / ::1. */
	allowLoopbackHttp?: boolean;
	/** Names compared for look-alikes. Default: the installed names plus WELL_KNOWN. */
	knownNames?: string[];
	/** Clock for the new-package note. */
	now?: Date;
}

export interface InstallResult {
	pkg: PinnedPackage;
	/** True when this exact pin was already installed and verified; nothing downloaded. */
	alreadyInstalled: boolean;
	/** Declared dependencies, which are NOT installed. */
	dependencies: string[];
	/** The package.json "8gent" field, if any (extensions, prompts, skills). */
	contributes?: unknown;
	/** Things the person should know before trusting it: look-alike name, brand-new package. */
	warnings: string[];
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Popular names a typo of which is worth a warning. */
export const WELL_KNOWN = [
	"@8gi-foundation/8gent-code",
	"react",
	"lodash",
	"express",
	"typescript",
	"chalk",
	"commander",
	"axios",
	"zod",
	"dotenv",
	"prettier",
	"eslint",
];

/** ~/.8gent/packages. Throws when there is no absolute home directory, rather than guess. */
export function defaultPackagesRoot(): string {
	const home = os.homedir();
	if (!home || !path.isAbsolute(home)) {
		throw new Error(
			`no absolute home directory (got "${home}"); refusing to pick a packages folder`,
		);
	}
	return path.join(home, ".8gent", "packages");
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

/** Is `p` strictly inside `root` (not root itself, not outside)? */
function inside(root: string, p: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(p));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The one folder a name@version may live in; throws if it would leave root. */
function pinnedDir(root: string, name: string, version: string): string {
	if (!NPM_NAME.test(name) || !EXACT.test(version)) {
		throw new Error(`refusing a folder for "${name}@${version}"`);
	}
	const dir = path.join(root, packageDirName(name, version));
	if (!inside(root, dir) || path.dirname(path.resolve(dir)) !== path.resolve(root)) {
		throw new Error(`${dir} is not directly inside ${root}`);
	}
	return dir;
}

/** Read the lock. Every entry must be well formed and point at its own folder, or the lock is refused. */
export function readLock(root: string): PackageLock {
	const file = path.join(root, LOCK_FILENAME);
	if (!fs.existsSync(file)) return { version: 1, packages: {} };
	const lock = JSON.parse(fs.readFileSync(file, "utf-8")) as PackageLock;
	if (lock?.version !== 1 || !lock.packages || typeof lock.packages !== "object") {
		throw new Error(`${file} is not a version 1 package lock`);
	}
	for (const [key, e] of Object.entries(lock.packages)) {
		const ok =
			e &&
			typeof e === "object" &&
			e.name === key &&
			NPM_NAME.test(key) &&
			typeof e.version === "string" &&
			EXACT.test(e.version) &&
			typeof e.integrity === "string" &&
			e.integrity.startsWith("sha512-") &&
			typeof e.filesRootHash === "string" &&
			typeof e.dir === "string" &&
			path.resolve(e.dir) === path.resolve(pinnedDir(root, key, e.version));
		if (!ok)
			throw new Error(
				`${file}: entry "${key}" is malformed or points outside its folder; refusing`,
			);
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

/** The registry base, checked: https, or loopback http when a test asks for it. */
function checkRegistry(registry: string, allowLoopbackHttp: boolean): URL {
	const u = new URL(registry);
	if (u.protocol === "https:") return u;
	if (u.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(u.hostname)) return u;
	throw new Error(`registry must be https (got ${u.protocol}//${u.host})`);
}

/** A tarball URL must be on the registry's own scheme and host. */
function checkTarballUrl(tarball: string, registry: URL): URL {
	const u = new URL(tarball);
	if (u.protocol !== registry.protocol || u.host !== registry.host) {
		throw new Error(
			`tarball ${u.protocol}//${u.host} is not on the registry host ${registry.host}; refusing`,
		);
	}
	return u;
}

/** Read a response body, refusing past `cap` bytes (checks Content-Length first, then counts while streaming). */
async function readCapped(res: Response, cap: number, what: string): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > cap) {
		throw new Error(`${what} is ${declared} bytes, over the ${cap} byte cap`);
	}
	if (!res.body) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			throw new Error(`${what} is over the ${cap} byte cap`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.byteLength;
	}
	return out;
}

/** Levenshtein distance, early exit past 3. */
export function editDistance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 3) return 4;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
}

interface RegistryVersion {
	version: string;
	dist: { tarball: string; integrity?: string };
	dependencies?: Record<string, string>;
}

interface RegistryDoc {
	"dist-tags"?: Record<string, string>;
	versions?: Record<string, RegistryVersion>;
	time?: Record<string, string>;
}

/** Resolve a source to one exact published version via the registry document. */
async function resolveVersion(
	src: NpmSource,
	registry: URL,
	doFetch: typeof fetch,
): Promise<{ v: RegistryVersion; doc: RegistryDoc }> {
	const url = `${registry.href.replace(/\/$/, "")}/${src.name.replace("/", "%2f")}`;
	const res = await doFetch(url, { headers: { accept: "application/json" }, redirect: "error" });
	if (!res.ok) throw new Error(`registry ${url} answered ${res.status}`);
	const doc = JSON.parse(
		Buffer.from(await readCapped(res, MAX_REGISTRY_JSON, "registry document")).toString("utf8"),
	) as RegistryDoc;
	const versions = doc.versions ?? {};
	const want = src.version ?? "latest";
	const exact = EXACT.test(want) ? want : doc["dist-tags"]?.[want];
	if (!exact) {
		throw new Error(
			`"${want}" is not an exact version or a dist-tag of ${src.name}; pin one, e.g. npm:${src.name}@${doc["dist-tags"]?.latest ?? "1.0.0"}`,
		);
	}
	// A dist-tag is registry data: it must name an exact version too.
	if (!EXACT.test(exact))
		throw new Error(`dist-tag "${want}" points at "${exact}", not an exact version`);
	const v = versions[exact];
	if (!v) throw new Error(`${src.name}@${exact} is not published`);
	if (v.version !== exact) throw new Error(`registry entry ${exact} says version "${v.version}"`);
	return { v, doc };
}

function warningsFor(name: string, doc: RegistryDoc, known: string[], now: Date): string[] {
	const out: string[] = [];
	const near = known.filter((k) => k !== name && editDistance(k, name) <= 2);
	if (near.length > 0) {
		out.push(
			`"${name}" looks like ${near.map((n) => `"${n}"`).join(", ")}: check it is the package you meant`,
		);
	}
	const created = doc.time?.created ? Date.parse(doc.time.created) : Number.NaN;
	if (Number.isFinite(created)) {
		const days = Math.floor((now.getTime() - created) / 86_400_000);
		if (days < NEW_PACKAGE_DAYS) out.push(`"${name}" was first published ${days} day(s) ago`);
	}
	return out;
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
	const root = path.resolve(opts.root ?? defaultPackagesRoot());
	const doFetch = opts.fetch ?? fetch;
	const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
	const registry = checkRegistry(
		opts.registry ?? DEFAULT_REGISTRY,
		opts.allowLoopbackHttp === true,
	);
	const lock = readLock(root);

	const { v: meta, doc } = await resolveVersion(src, registry, doFetch);
	const key = src.name;
	const dir = pinnedDir(root, key, meta.version);
	const known = opts.knownNames ?? [...WELL_KNOWN, ...Object.keys(lock.packages)];
	const warnings = warningsFor(key, doc, known, opts.now ?? new Date());
	const expected = meta.dist.integrity;
	if (!expected?.startsWith("sha512-")) {
		throw new Error(
			`${key}@${meta.version} has no sha512 integrity on the registry; refusing to install`,
		);
	}
	const tarballUrl = checkTarballUrl(meta.dist.tarball, registry);
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
				warnings,
			};
		}
	}

	const res = await doFetch(tarballUrl.href, { redirect: "error" });
	if (!res.ok) throw new Error(`tarball ${tarballUrl.href} answered ${res.status}`);
	const data = await readCapped(res, maxBytes, "tarball");
	const got = sri512(data);
	if (got !== expected) {
		throw new Error(
			`integrity mismatch for ${key}@${meta.version}: expected ${expected}, got ${got}`,
		);
	}
	// Every header is judged before a byte is written.
	let entries: ReturnType<typeof readNpmTarball>;
	try {
		entries = readNpmTarball(data);
	} catch (err) {
		throw new Error(`refusing ${key}@${meta.version}: ${(err as Error).message}`);
	}
	const manifestEntry = entries.find((e) => e.rel === "package.json" && e.type === "file");
	if (!manifestEntry) throw new Error(`refusing ${key}@${meta.version}: no package/package.json`);
	const manifest = JSON.parse(Buffer.from(manifestEntry.data).toString("utf8")) as {
		name?: string;
		version?: string;
		"8gent"?: unknown;
	};
	if (manifest.name !== key || manifest.version !== meta.version) {
		throw new Error(
			`tarball says ${manifest.name}@${manifest.version}, expected ${key}@${meta.version}`,
		);
	}

	fs.mkdirSync(root, { recursive: true });
	const staging = fs.mkdtempSync(path.join(root, ".staging-"));
	try {
		const out = path.join(staging, "package");
		writeEntries(entries, out);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(out, dir);
		const pkg: PinnedPackage = {
			name: key,
			version: meta.version,
			source: `npm:${key}@${meta.version}`,
			integrity: expected,
			filesRootHash: buildIntegrity(dir).rootHash,
			tarball: tarballUrl.href,
			dir,
			installedAt: new Date().toISOString(),
		};
		// A different version of the same name is replaced; its folder goes too,
		// and only ever a folder inside the root (readLock checked the entry).
		if (pinned && path.resolve(pinned.dir) !== dir && inside(root, pinned.dir)) {
			fs.rmSync(pinned.dir, { recursive: true, force: true });
		}
		lock.packages[key] = pkg;
		writeLock(root, lock);
		return {
			pkg,
			alreadyInstalled: false,
			dependencies: Object.keys(meta.dependencies ?? {}),
			contributes: manifest["8gent"],
			warnings,
		};
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Pinned packages, sorted by name. */
export function listPackages(opts: { root?: string } = {}): PinnedPackage[] {
	const lock = readLock(path.resolve(opts.root ?? defaultPackagesRoot()));
	return Object.values(lock.packages).sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a package and its pin. False when it was not installed. */
export function removePackage(name: string, opts: { root?: string } = {}): boolean {
	const root = path.resolve(opts.root ?? defaultPackagesRoot());
	const lock = readLock(root);
	const pinned = lock.packages[name];
	if (!pinned) return false;
	// Only ever delete inside the packages root.
	if (inside(root, pinned.dir)) fs.rmSync(pinned.dir, { recursive: true, force: true });
	delete lock.packages[name];
	writeLock(root, lock);
	return true;
}

/** Re-hash an installed package's files against its pin. */
export function verifyPackage(
	name: string,
	opts: { root?: string } = {},
): { ok: boolean; error?: string } {
	const root = path.resolve(opts.root ?? defaultPackagesRoot());
	const lock = readLock(root);
	const pinned = lock.packages[name];
	if (!pinned) return { ok: false, error: `${name} is not installed` };
	if (!inside(root, pinned.dir)) return { ok: false, error: `${pinned.dir} is outside ${root}` };
	if (!fs.existsSync(pinned.dir)) return { ok: false, error: `${pinned.dir} is missing` };
	const now = buildIntegrity(pinned.dir);
	if (now.rootHash !== pinned.filesRootHash) {
		return { ok: false, error: `${name}@${pinned.version} files changed since install` };
	}
	return { ok: true };
}
