/**
 * Self-update for `8gent update` (#3981, row A2 of the Pi gap plan).
 *
 * The old command always reinstalled from npm, whatever 8gent was installed
 * from, and took whatever version it found there, so "update" could install
 * an older 8gent. This module fixes both:
 *
 *   1. It updates from the channel 8gent was installed from. The primary
 *      install is the compiled binary from scripts/install.ps1 / install.sh,
 *      which updates from GitHub releases. npm is an optional channel: an
 *      npm install updates from npm. A source checkout is told to `git pull`.
 *   2. It never installs a version lower than the one running. Equal means
 *      up to date; lower is refused with both versions named.
 *
 * Network, process and file access are injected so every path is testable
 * offline. bin/8gent.ts (lane L3) wires `runSelfUpdate` into `8gent update`.
 */
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NPM_PACKAGE = "@8gi-foundation/8gent-code";
export const GITHUB_REPO = "8gi-foundation/8gent-code";

/**
 * Release signing key (minisign public key, base64). Kept identical to
 * scripts/release-signing.pub by self-update.test.ts. Empty until the
 * maintainer generates the release key; while empty, SHA256SUMS is not
 * signature-checked (the SHA256 and --version checks still apply).
 */
export const RELEASE_SIGNING_KEY = "";

export type InstallChannel = "binary" | "npm" | "source";

// ── Versions ─────────────────────────────────────────────────────────

/** [major, minor, patch] for a strict X.Y.Z (optional leading v), else null. */
export function parseVersion(v: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1. Throws on anything that is not X.Y.Z, so a bad string can never pass as "newer". */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) throw new Error(`not an X.Y.Z version: ${!x ? a : b}`);
	for (let i = 0; i < 3; i++) {
		if (x[i] > y[i]) return 1;
		if (x[i] < y[i]) return -1;
	}
	return 0;
}

export type UpdateDecision =
	| { action: "update"; from: string; to: string }
	| { action: "current"; version: string }
	| { action: "refuse-downgrade"; from: string; to: string };

/** The only place that decides whether to install. Lower is never an update. */
export function decideUpdate(current: string, available: string): UpdateDecision {
	const c = compareVersions(available, current);
	if (c > 0) return { action: "update", from: current, to: available };
	if (c === 0) return { action: "current", version: current };
	return { action: "refuse-downgrade", from: current, to: available };
}

// ── Channel ──────────────────────────────────────────────────────────

export interface ChannelProbe {
	/** import.meta.url / module path of the running entry. */
	modulePath: string;
	/** true inside a compiled binary (the module path is in Bun's virtual filesystem). */
	embedded?: boolean;
	/** Does <dir>/.git exist? Injected for tests. */
	isGitCheckout?: (path: string) => boolean;
}

/**
 * binary: a `bun build --compile` executable (module paths live under
 * /$bunfs or B:/~BUN). source: run from a git checkout (bun run tui, bin/8gent.ts).
 * npm: everything else, i.e. inside a global node_modules.
 */
export function detectChannel(p: ChannelProbe): InstallChannel {
	if (p.embedded || /(^|[\\/])(\$bunfs|~BUN)([\\/]|$)/i.test(p.modulePath)) return "binary";
	if (/[\\/]node_modules[\\/]/.test(p.modulePath)) return "npm";
	const hasGit = p.isGitCheckout ?? ((dir: string) => existsSync(`${dir}/.git`));
	const parts = p.modulePath.replace(/^file:\/\//, "").split(/[\\/]/);
	for (let i = parts.length - 1; i > 0; i--) {
		if (hasGit(parts.slice(0, i).join("/") || "/")) return "source";
	}
	return "npm";
}

// ── What is available ────────────────────────────────────────────────

export interface FetchResponse {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

export type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string>; redirect?: "manual" },
) => Promise<FetchResponse>;

/** Hosts a GitHub release download may redirect through. */
const GITHUB_HOSTS = new Set([
	"github.com",
	"api.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
]);

type UrlKind = "list" | "asset" | "npm";

function isHttps(url: string): URL | null {
	try {
		const u = new URL(url);
		return u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/** The first URL of a download: a release list, a release asset, or the npm registry. */
export function urlAllowed(url: string, kind: UrlKind, repo = GITHUB_REPO): boolean {
	const u = isHttps(url);
	if (!u) return false;
	if (kind === "npm") return u.hostname === "registry.npmjs.org";
	// The parsed href, not the raw string: fetch resolves `..` and `%2e%2e`, so a
	// raw prefix check lets `.../releases/download/../../../../x/y/...` leave the repo.
	if (kind === "asset") return u.href.startsWith(`https://github.com/${repo}/releases/download/`);
	return true;
}

/** A redirect hop: https, and to GitHub's download hosts (or the registry for npm). */
export function hopAllowed(url: string, kind: UrlKind): boolean {
	const u = isHttps(url);
	if (!u) return false;
	return kind === "npm" ? u.hostname === "registry.npmjs.org" : GITHUB_HOSTS.has(u.hostname);
}

/** GET with redirects followed by hand, so every hop is checked. */
export async function fetchChecked(
	fetchImpl: FetchLike,
	url: string,
	kind: UrlKind,
	headers: Record<string, string> = {},
): Promise<FetchResponse> {
	if (!urlAllowed(url, kind)) throw new Error(`refusing to download from ${url}`);
	let current = url;
	for (let hop = 0; hop <= 5; hop++) {
		const res = await fetchImpl(current, {
			headers: { "user-agent": "8gent-self-update", ...headers },
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) throw new Error(`redirect without a location from ${current}`);
			const next = new URL(loc, current).toString();
			if (!hopAllowed(next, kind)) throw new Error(`refusing a redirect to ${next}`);
			current = next;
			continue;
		}
		return res;
	}
	throw new Error(`too many redirects for ${url}`);
}

/** npm's `latest` dist-tag. */
export async function latestFromNpm(fetchImpl: FetchLike): Promise<string> {
	const res = await fetchChecked(
		fetchImpl,
		`https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2f")}`,
		"npm",
		{ accept: "application/vnd.npm.install-v1+json" },
	);
	if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
	const body = (await res.json()) as { "dist-tags"?: { latest?: string } };
	const latest = body["dist-tags"]?.latest;
	if (!latest || !parseVersion(latest))
		throw new Error("npm registry has no usable latest version");
	return latest;
}

/**
 * Release asset names for this platform, in the order to try them (as
 * scripts/build-binaries.ts names them). Windows tries the baseline build
 * (CPUs without AVX2) when the x64 build will not start, like install.ps1.
 */
export function binaryAssetNames(platform: string, arch: string): string[] {
	const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	if (!a) return [];
	if (platform === "win32") return ["8gent-windows-x64.exe", "8gent-windows-x64-baseline.exe"];
	if (platform === "darwin") return [`8gent-darwin-${a}`];
	if (platform === "linux") return [`8gent-linux-${a}`];
	return [];
}

/** The primary asset name for this platform, or null. */
export function binaryAssetName(platform: string, arch: string): string | null {
	return binaryAssetNames(platform, arch)[0] ?? null;
}

export interface ReleaseBinary {
	version: string;
	/** asset name -> download URL, for every asset on the release */
	urls: Record<string, string>;
	asset: string;
}

interface GhRelease {
	tag_name?: string;
	draft?: boolean;
	prerelease?: boolean;
	assets?: { name?: string; browser_download_url?: string }[];
}

/**
 * Newest published vX.Y.Z GitHub release that carries this platform's binary
 * and SHA256SUMS. Releases without assets, drafts and prereleases are skipped.
 * `asset` may depend on the version (the npm tarball is named after it).
 */
export async function latestBinaryRelease(
	fetchImpl: FetchLike,
	assetFor: string | ((version: string) => string),
	releasesUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`,
): Promise<ReleaseBinary | null> {
	const res = await fetchChecked(fetchImpl, releasesUrl, "list", {
		accept: "application/vnd.github+json",
	});
	if (!res.ok) throw new Error(`GitHub releases answered ${res.status}`);
	const list = (await res.json()) as GhRelease[];
	let best: ReleaseBinary | null = null;
	for (const r of Array.isArray(list) ? list : []) {
		if (r.draft || r.prerelease || !r.tag_name) continue;
		const v = /^v(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1];
		if (!v) continue;
		const asset = typeof assetFor === "string" ? assetFor : assetFor(v);
		const urls: Record<string, string> = {};
		for (const a of r.assets ?? []) {
			if (a.name && a.browser_download_url) urls[a.name] = a.browser_download_url;
		}
		if (!urls[asset] || !urls.SHA256SUMS) continue;
		if (!best || compareVersions(v, best.version) > 0) best = { version: v, urls, asset };
	}
	return best;
}

/** The npm tarball release.yml attaches to every GitHub release (`npm pack` naming). */
export function npmTarballName(version: string): string {
	return `${NPM_PACKAGE.slice(1).replace("/", "-")}-${version}.tgz`;
}

/** A release tag 8gent will install from: exactly vX.Y.Z. */
export const RELEASE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The newest release from the https://github.com/<repo>/releases/latest
 * redirect, for when api.github.com refuses (anonymous rate limit, 403). The
 * redirect is read, not followed: its location must be
 * https://github.com/<repo>/releases/tag/vX.Y.Z. Asset URLs are built under
 * github.com/<repo>/releases/download/<tag>/, the same prefix urlAllowed
 * requires of every download.
 */
export async function latestReleaseFromRedirect(
	fetchImpl: FetchLike,
	assetFor: string | ((version: string) => string),
	repo = GITHUB_REPO,
): Promise<ReleaseBinary> {
	const url = `https://github.com/${repo}/releases/latest`;
	const res = await fetchImpl(url, {
		headers: { "user-agent": "8gent-self-update" },
		redirect: "manual",
	});
	if (res.status < 300 || res.status >= 400)
		throw new Error(`${url} answered ${res.status}, not a redirect`);
	const loc = res.headers.get("location");
	if (!loc) throw new Error(`redirect without a location from ${url}`);
	let next: URL;
	try {
		next = new URL(loc, url);
	} catch {
		throw new Error(`unreadable release redirect: ${loc}`);
	}
	const prefix = `/${repo}/releases/tag/`;
	if (
		next.protocol !== "https:" ||
		next.hostname !== "github.com" ||
		!next.pathname.startsWith(prefix)
	)
		throw new Error(`refusing a release redirect to ${next.href}`);
	const tag = next.pathname.slice(prefix.length);
	if (!RELEASE_TAG_RE.test(tag)) throw new Error(`refusing release tag "${tag}": not vX.Y.Z`);
	const version = tag.slice(1);
	const asset = typeof assetFor === "string" ? assetFor : assetFor(version);
	const urls: Record<string, string> = {};
	for (const name of [asset, "SHA256SUMS", "SHA256SUMS.minisig"])
		urls[name] = `https://github.com/${repo}/releases/download/${tag}/${name}`;
	return { version, urls, asset };
}

/** What the npm channel installs: the GitHub release package, or (GitHub unreachable) npm by name. */
export type NpmTarget = {
	version: string;
	release: ReleaseBinary | null;
	/** Where the version came from. */
	source: "github-api" | "github-redirect" | "npm";
};

/**
 * The npm registry version when it is newer than the GitHub release `version`,
 * else null. npm publishes minutes before release-binaries.yml publishes the
 * GitHub release, so for a short window the release list lags npm and a plain
 * "Already up to date" is wrong. Best effort: a registry that cannot be
 * reached means no claim either way.
 */
export async function npmVersionAhead(
	fetchImpl: FetchLike,
	releaseVersion: string,
): Promise<string | null> {
	try {
		const latest = await latestFromNpm(fetchImpl);
		return compareVersions(latest, releaseVersion) > 0 ? latest : null;
	} catch {
		return null;
	}
}

/**
 * The npm channel's newest version. The GitHub release package first (#3658,
 * #4698): npm latest sat at 0.17.0 from May to October while releases moved
 * on, so npm users must not depend on it. The release list comes from
 * api.github.com; on any error there (an anonymous 403 rate limit is common)
 * the github.com releases/latest redirect names the tag instead. npm's
 * registry decides only when GitHub has no release with the package or
 * cannot be reached at all.
 */
export async function latestForNpmChannel(
	fetchImpl: FetchLike,
	releasesUrl?: string,
): Promise<NpmTarget> {
	let apiProblem: unknown = null;
	try {
		const rel = await latestBinaryRelease(fetchImpl, npmTarballName, releasesUrl);
		if (rel) return { version: rel.version, release: rel, source: "github-api" };
	} catch (err) {
		apiProblem = err;
	}
	let redirectProblem: unknown = null;
	if (apiProblem) {
		try {
			const rel = await latestReleaseFromRedirect(fetchImpl, npmTarballName);
			return { version: rel.version, release: rel, source: "github-redirect" };
		} catch (err) {
			redirectProblem = err;
		}
	}
	try {
		return { version: await latestFromNpm(fetchImpl), release: null, source: "npm" };
	} catch (err) {
		if (!apiProblem) throw err;
		const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
		throw new Error(
			`could not find the newest release: ${msg(apiProblem)}; ${msg(redirectProblem)}; ${msg(err)}`,
		);
	}
}

// ── Signature (minisign) ─────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify a minisign signature file over `message` with a minisign public key
 * (the base64 line of a .pub file). Supports pure ("Ed") and prehashed
 * ("ED", BLAKE2b-512) signatures, and checks the trusted-comment signature.
 */
export function verifyMinisign(message: Uint8Array, sigFile: string, publicKey: string): boolean {
	try {
		const pk = Buffer.from(publicKey.trim(), "base64");
		if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed") return false;
		const lines = sigFile.split(/\r?\n/);
		const sig = Buffer.from((lines[1] ?? "").trim(), "base64");
		const trusted = lines[2] ?? "";
		const globalSig = Buffer.from((lines[3] ?? "").trim(), "base64");
		if (sig.length !== 74 || globalSig.length !== 64) return false;
		if (!trusted.startsWith("trusted comment: ")) return false;
		const alg = sig.subarray(0, 2).toString();
		if (alg !== "Ed" && alg !== "ED") return false;
		if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) return false;
		const key = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, pk.subarray(10)]),
			format: "der",
			type: "spki",
		});
		const signed = alg === "ED" ? createHash("blake2b512").update(message).digest() : message;
		const sigBytes = sig.subarray(10);
		if (!cryptoVerify(null, signed, key, sigBytes)) return false;
		const comment = Buffer.from(trusted.slice("trusted comment: ".length));
		return cryptoVerify(null, Buffer.concat([sigBytes, comment]), key, globalSig);
	} catch {
		return false;
	}
}

// ── Installing ───────────────────────────────────────────────────────

export interface SelfUpdateOptions {
	currentVersion: string;
	channel: InstallChannel;
	/** The running executable (process.execPath); replaced on the binary channel. */
	execPath: string;
	platform?: string;
	arch?: string;
	fetchImpl?: FetchLike;
	/** Runs a command, resolves to its exit code. */
	run?: (cmd: string, args: string[], opts: { shell: boolean }) => Promise<number>;
	/** Runs `<file> --version` (15 s limit), resolves to stdout. */
	probeVersion?: (file: string) => Promise<string>;
	log?: (line: string) => void;
	releasesUrl?: string;
	/** Release signing key; defaults to RELEASE_SIGNING_KEY. Tests only. */
	signingKey?: string;
	/** Where the npm channel stages a release tarball; defaults to os.tmpdir(). Tests only. */
	tmpDir?: string;
	/** npm global prefix to install into (npmPrefixFromModulePath); npm's own default when absent. */
	npmPrefix?: string | null;
}

export type SelfUpdateResult =
	| { status: "updated"; from: string; to: string; channel: InstallChannel }
	| { status: "current"; version: string; channel: InstallChannel }
	| { status: "refused-downgrade"; from: string; to: string; channel: InstallChannel }
	| { status: "source"; message: string }
	| { status: "failed"; message: string; channel: InstallChannel };

/**
 * The npm global prefix this 8gent was installed into, read from its own path
 * (#4188): <prefix>/lib/node_modules/@8gi-foundation/8gent-code on macOS and
 * Linux, <prefix>\node_modules\@8gi-foundation\8gent-code on Windows. The `npm`
 * first on PATH can have another prefix (Homebrew 8gent under /opt/homebrew,
 * a second npm defaulting to /usr/local): updating there fails EACCES or
 * installs a second copy beside the one running. null when not an npm global.
 */
export function npmPrefixFromModulePath(modulePath: string, platform: string): string | null {
	let p = modulePath;
	if (p.startsWith("file:")) {
		try {
			p = fileURLToPath(p);
		} catch {
			return null;
		}
	}
	const pkg = NPM_PACKAGE.split("/").join("[\\\\/]");
	const re =
		platform === "win32"
			? new RegExp(`^(.+?)[\\\\/]node_modules[\\\\/]${pkg}([\\\\/]|$)`)
			: new RegExp(`^(.*?)/lib/node_modules/${pkg}(/|$)`);
	const m = re.exec(p);
	if (!m) return null;
	return m[1] || "/";
}

/**
 * The npm command for an exact version, or for a verified release tarball on
 * disk (with --ignore-scripts), into `prefix` when known. --force only on the retry (`force`): it
 * replaces stale `8` / `8gent` / `8gent-code` bin links (EEXIST), and must not
 * paper over anything else. Windows needs npm.cmd through a shell, so paths
 * are quoted there.
 */
export function npmInstallCommand(
	version: string,
	platform: string,
	tarball?: string,
	opts: { prefix?: string | null; force?: boolean } = {},
): { cmd: string; args: string[]; shell: boolean } {
	const win = platform === "win32";
	const q = (path: string) => (win ? `"${path}"` : path);
	// Exact version, never a tag: what was checked is what gets installed.
	const spec = tarball ? q(tarball) : `${NPM_PACKAGE}@${version}`;
	const args = ["install", "-g", spec];
	// A verified release package installs inert, as scripts/install.sh does on Termux.
	if (tarball) args.push("--ignore-scripts");
	if (opts.prefix) args.push("--prefix", q(opts.prefix));
	if (opts.force) args.push("--force");
	return { cmd: win ? "npm.cmd" : "npm", args, shell: win };
}

/** Run the npm install; once more with --force if it fails. The exit code of the last run. */
async function runNpmInstall(
	o: Pick<SelfUpdateOptions, "run" | "npmPrefix"> & { log: (line: string) => void },
	version: string,
	platform: string,
	tarball?: string,
): Promise<number> {
	const run = o.run ?? defaultRun;
	const first = npmInstallCommand(version, platform, tarball, { prefix: o.npmPrefix });
	const code = await run(first.cmd, first.args, { shell: first.shell });
	if (code === 0) return 0;
	o.log(`npm exited ${code}; retrying once with --force (replaces stale 8gent bin links).`);
	const retry = npmInstallCommand(version, platform, tarball, { prefix: o.npmPrefix, force: true });
	return run(retry.cmd, retry.args, { shell: retry.shell });
}

/** The command a person can run by hand after a failed update. */
function npmHint(spec: string, prefix?: string | null, ignoreScripts = false): string {
	// local-first-gate: optin the 8gent update command installs 8gent itself
	return `npm install -g ${spec}${ignoreScripts ? " --ignore-scripts" : ""}${prefix ? ` --prefix ${prefix}` : ""} --force`;
}

function defaultRun(cmd: string, args: string[], opts: { shell: boolean }): Promise<number> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { stdio: "inherit", shell: opts.shell });
		p.on("exit", (code) => resolve(code ?? 1));
		p.on("error", () => resolve(127));
	});
}

export const PROBE_TIMEOUT_MS = 15_000;

/** `<file> --version` with a 15 s limit; a hung binary is killed and reads as "". */
export function probeVersionWithTimeout(
	file: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		// Assigned after spawn; finish() can run first (spawn throws) and must see undefined, not a TDZ error.
		let timer: ReturnType<typeof setTimeout> | undefined = undefined;
		const finish = (v: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(v);
		};
		let p: ReturnType<typeof spawn>;
		try {
			p = spawn(file, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			// Bun on Windows throws (EFTYPE, EACCES) for a file it cannot execute instead of emitting
			// "error"; an unrunnable binary reads as "" either way.
			finish("");
			return;
		}
		timer = setTimeout(() => {
			p.kill("SIGKILL");
			finish("");
		}, timeoutMs);
		p.stdout?.on("data", (d) => {
			out += String(d);
		});
		p.on("exit", () => finish(out));
		p.on("error", () => finish(""));
	});
}

function sha256Hex(buf: Uint8Array): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Hash for `asset` from a SHA256SUMS body ("<hex>  <name>" or "<hex> *<name>"). */
export function sumFor(sums: string, asset: string): string | null {
	for (const line of sums.split(/\r?\n/)) {
		const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
		if (m && m[2].trim() === asset) return m[1].toLowerCase();
	}
	return null;
}

async function download(fetchImpl: FetchLike, url: string): Promise<Uint8Array> {
	if (!urlAllowed(url, "asset"))
		throw new Error(`refusing a download URL outside ${GITHUB_REPO}'s releases: ${url}`);
	const res = await fetchChecked(fetchImpl, url, "asset");
	if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
	return new Uint8Array(await res.arrayBuffer());
}

/** Put `staged` in place of `target`. Windows renames the running exe aside first, with rollback. */
function swapInto(staged: string, target: string, platform: string): void {
	if (platform !== "win32") {
		renameSync(staged, target);
		return;
	}
	let old = `${target}.old`;
	try {
		rmSync(old, { force: true });
	} catch {
		old = `${target}.old-${randomBytes(4).toString("hex")}`;
	}
	const hadTarget = existsSync(target);
	if (hadTarget) renameSync(target, old);
	try {
		renameSync(staged, target);
	} catch (err) {
		if (hadTarget && !existsSync(target)) renameSync(old, target);
		throw err;
	}
}

/** The release's SHA256SUMS, signature-checked when a release key is configured. */
async function verifiedSums(
	o: Required<Pick<SelfUpdateOptions, "fetchImpl">> & SelfUpdateOptions,
	rel: ReleaseBinary,
): Promise<{ ok: true; sums: string } | { ok: false; problem: string }> {
	const sumsBytes = await download(o.fetchImpl, rel.urls.SHA256SUMS);
	const key = (o.signingKey ?? RELEASE_SIGNING_KEY).trim();
	if (key) {
		const sigUrl = rel.urls["SHA256SUMS.minisig"];
		if (!sigUrl)
			return {
				ok: false,
				problem: `v${rel.version} has no SHA256SUMS.minisig; refusing unsigned checksums`,
			};
		const sig = new TextDecoder().decode(await download(o.fetchImpl, sigUrl));
		if (!verifyMinisign(sumsBytes, sig, key))
			return {
				ok: false,
				problem: `SHA256SUMS for v${rel.version} does not carry a valid release signature; nothing changed`,
			};
	}
	return { ok: true, sums: new TextDecoder().decode(sumsBytes) };
}

/**
 * The npm channel from a GitHub release: download the npm tarball, check it
 * against SHA256SUMS (signed when a release key is configured), then
 * `npm install -g <file>`. Same bytes release.yml would have published to npm.
 */
async function updateNpmFromRelease(
	o: Required<Pick<SelfUpdateOptions, "fetchImpl" | "log">> & SelfUpdateOptions,
	rel: ReleaseBinary,
	platform: string,
): Promise<string | null> {
	const name = rel.asset;
	const checked = await verifiedSums(o, rel);
	if (!checked.ok) return checked.problem;
	const expected = sumFor(checked.sums, name);
	if (!expected)
		return `SHA256SUMS for v${rel.version} does not list ${name}; refusing an unverified package`;
	o.log(`Downloading ${name} from the v${rel.version} GitHub release...`);
	const bytes = await download(o.fetchImpl, rel.urls[name]);
	const actual = sha256Hex(bytes);
	if (actual !== expected)
		return `checksum mismatch for ${name} (expected ${expected}, got ${actual}); nothing changed`;
	o.log(`SHA256 matches SHA256SUMS: ${actual}`);
	// A private (0700) directory under an absolute path: npm reads a relative
	// "dir/x.tgz" as a package spec, not a file.
	const dir = mkdtempSync(join(resolve(o.tmpDir ?? tmpdir()), "8gent-update-"));
	try {
		const file = join(dir, name);
		writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
		// local-first-gate: optin the 8gent update command installs 8gent itself
		o.log(`Installing with npm, package scripts off: npm install -g ${file} --ignore-scripts`);
		const code = await runNpmInstall(o, rel.version, platform, file);
		return code === 0
			? null
			: `npm exited ${code}. Try: ${npmHint(rel.urls[name], o.npmPrefix, true)}`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Download, verify and swap the running binary. Order: signed SHA256SUMS
 * (when a release key is configured), the binary's SHA256, then the new
 * binary's own --version; only then is the running one replaced. On Windows
 * the baseline build is tried when the x64 build will not start.
 */
async function updateBinary(
	o: Required<Pick<SelfUpdateOptions, "fetchImpl" | "probeVersion" | "log">> & SelfUpdateOptions,
	rel: ReleaseBinary,
	names: string[],
): Promise<string | null> {
	const platform = o.platform ?? process.platform;
	const checked = await verifiedSums(o, rel);
	if (!checked.ok) return checked.problem;
	const sums = checked.sums;
	const target = o.execPath;
	let lastProblem = `no ${names.join(" or ")} on v${rel.version}`;
	for (const name of names) {
		const url = rel.urls[name];
		if (!url) continue;
		const expected = sumFor(sums, name);
		if (!expected)
			return `SHA256SUMS for v${rel.version} does not list ${name}; refusing an unverified binary`;
		const bytes = await download(o.fetchImpl, url);
		const actual = sha256Hex(bytes);
		if (actual !== expected)
			return `checksum mismatch for ${name} (expected ${expected}, got ${actual}); nothing changed`;
		// A fresh, uniquely named file beside the target, created exclusively (wx).
		const staged = `${target}.${randomBytes(6).toString("hex")}.new`;
		writeFileSync(staged, bytes, { flag: "wx", mode: 0o755 });
		try {
			chmodSync(staged, 0o755);
		} catch {}
		const reported = /8gent Code v(\d+\.\d+\.\d+)/.exec(await o.probeVersion(staged))?.[1];
		if (reported !== rel.version) {
			rmSync(staged, { force: true });
			lastProblem = `${name} reported '${reported ?? "nothing"}', not v${rel.version}`;
			continue;
		}
		try {
			swapInto(staged, target, platform);
		} catch (err) {
			rmSync(staged, { force: true });
			throw err;
		}
		return null;
	}
	return `${lastProblem}; nothing changed`;
}

const NPM_SOURCE_LABEL: Record<NpmTarget["source"], string> = {
	"github-api": "GitHub release",
	"github-redirect":
		"GitHub release, found through github.com because the GitHub API did not answer",
	npm: "npm registry, GitHub releases could not be reached",
};

/** Set when npm has a version newer than the GitHub release we just found. */
async function lagMessage(
	o: { fetchImpl: FetchLike; npmPrefix?: string | null },
	releaseVersion: string,
): Promise<string | null> {
	const ahead = await npmVersionAhead(o.fetchImpl, releaseVersion);
	if (!ahead) return null;
	return `npm has ${ahead}, but its GitHub release is not published yet (v${releaseVersion} is the newest release). Try again in a few minutes, or run: ${npmHint(`${NPM_PACKAGE}@${ahead}`, o.npmPrefix)}`;
}

export async function runSelfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
	const o = {
		...opts,
		fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
		probeVersion: opts.probeVersion ?? ((f: string) => probeVersionWithTimeout(f)),
		log: opts.log ?? ((line: string) => console.log(line)),
	};
	const platform = o.platform ?? process.platform;
	const arch = o.arch ?? process.arch;
	const ch = o.channel;

	if (ch === "source") {
		return {
			status: "source",
			message: "This 8gent runs from a source checkout. Update it with: 8gent update",
		};
	}

	try {
		if (ch === "npm") {
			const target = await latestForNpmChannel(o.fetchImpl, o.releasesUrl);
			o.log(`Latest version: v${target.version} (${NPM_SOURCE_LABEL[target.source]}).`);
			const d = decideUpdate(o.currentVersion, target.version);
			if (d.action === "current") {
				// The release package stays the install source (#4698), so a newer
				// npm version is reported, never installed from the registry here.
				const lag = target.release ? await lagMessage(o, target.version) : null;
				if (lag) return { status: "failed", channel: ch, message: lag };
				return { status: "current", version: d.version, channel: ch };
			}
			if (d.action === "refuse-downgrade")
				return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
			if (target.release) {
				o.log(`Updating ${NPM_PACKAGE} v${d.from} -> v${d.to} from the GitHub release...`);
				const err = await updateNpmFromRelease(o, target.release, platform);
				if (err) return { status: "failed", channel: ch, message: err };
				return { status: "updated", from: d.from, to: d.to, channel: ch };
			}
			o.log(`Updating ${NPM_PACKAGE} v${d.from} -> v${d.to} with npm...`);
			const code = await runNpmInstall(o, d.to, platform);
			if (code !== 0)
				return {
					status: "failed",
					channel: ch,
					message: `npm exited ${code}. Try: ${npmHint(`${NPM_PACKAGE}@${d.to}`, o.npmPrefix)}`,
				};
			return { status: "updated", from: d.from, to: d.to, channel: ch };
		}

		const names = binaryAssetNames(platform, arch);
		if (names.length === 0)
			return { status: "failed", channel: ch, message: `no 8gent binary for ${platform}/${arch}` };
		const rel = await latestBinaryRelease(o.fetchImpl, names[0], o.releasesUrl);
		if (!rel)
			return { status: "failed", channel: ch, message: `no release carries ${names[0]} yet` };
		o.log(`Latest version: v${rel.version} (GitHub release).`);
		const d = decideUpdate(o.currentVersion, rel.version);
		if (d.action === "current") {
			const lag = await lagMessage(o, rel.version);
			if (lag) return { status: "failed", channel: ch, message: lag };
			return { status: "current", version: d.version, channel: ch };
		}
		if (d.action === "refuse-downgrade")
			return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
		o.log(`Updating 8gent v${d.from} -> v${d.to} (${names[0]})...`);
		const err = await updateBinary(o, rel, names);
		if (err) return { status: "failed", channel: ch, message: err };
		return { status: "updated", from: d.from, to: d.to, channel: ch };
	} catch (err) {
		return {
			status: "failed",
			channel: ch,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/** One line a user can read, for each result. */
export function describeResult(r: SelfUpdateResult): string {
	switch (r.status) {
		case "updated":
			return `Updated 8gent v${r.from} -> v${r.to}. Open a new terminal, then run 8gent.`;
		case "current":
			return `8gent v${r.version} is the newest release.`;
		case "refused-downgrade":
			return `Not updating: the newest ${r.channel === "npm" ? "npm" : "release"} version is v${r.to}, lower than this v${r.from}. 8gent never installs an older version over a newer one.`;
		case "source":
			return r.message;
		case "failed":
			return `Update failed: ${r.message}`;
	}
}

// ── Changelog (row A5, data side) ────────────────────────────────────

/**
 * Path of the CHANGELOG.md shipped with this 8gent: embedded in the compiled
 * binary (scripts/build-binaries.ts sets __EIGHT_EMBEDDED_CHANGELOG), or at the
 * npm package root (package.json "files"), found by walking up from `fromDir`.
 */
export function bundledChangelogPath(fromDir: string): string | null {
	const embedded = (globalThis as Record<string, unknown>).__EIGHT_EMBEDDED_CHANGELOG;
	if (typeof embedded === "string" && existsSync(embedded)) return embedded;
	let dir = fromDir.replace(/^file:\/\//, "");
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, "CHANGELOG.md");
		if (existsSync(candidate) && existsSync(join(dir, "package.json"))) return candidate;
		const up = dir.replace(/[\\/][^\\/]*$/, "");
		if (!up || up === dir) break;
		dir = up;
	}
	return null;
}

/**
 * The CHANGELOG sections for versions newer than `since` and no newer than
 * `upTo`, newest first: what changed between the version a user had and the
 * one they now run. Sections are "## [X.Y.Z] ..." headings; [Unreleased] is skipped.
 */
export function changelogBetween(markdown: string, since: string, upTo: string): string {
	const out: string[] = [];
	let keep = false;
	for (const line of markdown.split(/\r?\n/)) {
		const h = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
		if (h) {
			keep = compareVersions(h[1], since) > 0 && compareVersions(h[1], upTo) <= 0;
		} else if (line.startsWith("## ")) {
			keep = false;
		}
		if (keep) out.push(line);
	}
	return out.join("\n").trim();
}
