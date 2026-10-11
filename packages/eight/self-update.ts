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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const NPM_PACKAGE = "@8gi-foundation/8gent-code";
export const GITHUB_REPO = "8gi-foundation/8gent-code";

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
	/** true when a compiled binary set globalThis.__EIGHT_EMBEDDED_TUI. */
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

export type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}>;

/** npm's `latest` dist-tag. */
export async function latestFromNpm(fetchImpl: FetchLike): Promise<string> {
	const res = await fetchImpl(`https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2f")}`, {
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
	const body = (await res.json()) as { "dist-tags"?: { latest?: string } };
	const latest = body["dist-tags"]?.latest;
	if (!latest || !parseVersion(latest))
		throw new Error("npm registry has no usable latest version");
	return latest;
}

/** Release asset name for this platform, as scripts/build-binaries.ts names it. */
export function binaryAssetName(platform: string, arch: string): string | null {
	const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	if (!a) return null;
	if (platform === "win32") return "8gent-windows-x64.exe";
	if (platform === "darwin") return `8gent-darwin-${a}`;
	if (platform === "linux") return `8gent-linux-${a}`;
	return null;
}

export interface ReleaseBinary {
	version: string;
	url: string;
	sumsUrl: string;
	asset: string;
}

interface GhRelease {
	tag_name?: string;
	draft?: boolean;
	prerelease?: boolean;
	assets?: { name?: string; browser_download_url?: string }[];
}

/**
 * Newest vX.Y.Z GitHub release that carries this platform's binary and
 * SHA256SUMS. Releases without assets (v0.18.1, v0.19.0) are skipped.
 */
export async function latestBinaryRelease(
	fetchImpl: FetchLike,
	asset: string,
	releasesUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`,
): Promise<ReleaseBinary | null> {
	const res = await fetchImpl(releasesUrl, {
		headers: { accept: "application/vnd.github+json", "user-agent": "8gent-self-update" },
	});
	if (!res.ok) throw new Error(`GitHub releases answered ${res.status}`);
	const list = (await res.json()) as GhRelease[];
	let best: ReleaseBinary | null = null;
	for (const r of Array.isArray(list) ? list : []) {
		if (r.draft || r.prerelease || !r.tag_name) continue;
		const v = /^v(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1];
		if (!v) continue;
		const bin = r.assets?.find((x) => x.name === asset)?.browser_download_url;
		const sums = r.assets?.find((x) => x.name === "SHA256SUMS")?.browser_download_url;
		if (!bin || !sums) continue;
		if (!best || compareVersions(v, best.version) > 0)
			best = { version: v, url: bin, sumsUrl: sums, asset };
	}
	return best;
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
	/** Runs `<file> --version`, resolves to stdout. */
	probeVersion?: (file: string) => Promise<string>;
	log?: (line: string) => void;
	releasesUrl?: string;
}

export type SelfUpdateResult =
	| { status: "updated"; from: string; to: string; channel: InstallChannel }
	| { status: "current"; version: string; channel: InstallChannel }
	| { status: "refused-downgrade"; from: string; to: string; channel: InstallChannel }
	| { status: "source"; message: string }
	| { status: "failed"; message: string; channel: InstallChannel };

/** The npm command for an exact version. Windows needs npm.cmd through a shell. */
export function npmInstallCommand(
	version: string,
	platform: string,
): { cmd: string; args: string[]; shell: boolean } {
	const win = platform === "win32";
	return {
		cmd: win ? "npm.cmd" : "npm",
		// Exact version, never a tag: what was checked is what gets installed.
		// --force replaces stale `8` / `8gent` / `8gent-code` bin links (EEXIST).
		args: ["install", "-g", `${NPM_PACKAGE}@${version}`, "--force"],
		shell: win,
	};
}

function defaultRun(cmd: string, args: string[], opts: { shell: boolean }): Promise<number> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { stdio: "inherit", shell: opts.shell });
		p.on("exit", (code) => resolve(code ?? 1));
		p.on("error", () => resolve(127));
	});
}

function defaultProbe(file: string): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		const p = spawn(file, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		p.stdout?.on("data", (d) => {
			out += String(d);
		});
		p.on("exit", () => resolve(out));
		p.on("error", () => resolve(""));
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

/**
 * Download, verify and swap the running binary. The new file is checked
 * (SHA256 and its own --version) before the old one is touched. Windows
 * cannot overwrite a running exe but can rename it, so the old one moves to
 * <exe>.old and is cleaned up by the next update.
 */
async function updateBinary(
	o: Required<Pick<SelfUpdateOptions, "fetchImpl" | "probeVersion" | "log">> & SelfUpdateOptions,
	rel: ReleaseBinary,
): Promise<string | null> {
	const bin = await o.fetchImpl(rel.url, { headers: { "user-agent": "8gent-self-update" } });
	if (!bin.ok) return `download failed (${bin.status}): ${rel.url}`;
	const bytes = new Uint8Array(await bin.arrayBuffer());
	const sumsRes = await o.fetchImpl(rel.sumsUrl, {
		headers: { "user-agent": "8gent-self-update" },
	});
	if (!sumsRes.ok)
		return `could not read SHA256SUMS for v${rel.version}; refusing an unverified binary`;
	const expected = sumFor(await sumsRes.text(), rel.asset);
	if (!expected)
		return `SHA256SUMS for v${rel.version} does not list ${rel.asset}; refusing an unverified binary`;
	const actual = sha256Hex(bytes);
	if (actual !== expected)
		return `checksum mismatch for ${rel.asset} (expected ${expected}, got ${actual}); nothing changed`;

	const target = o.execPath;
	const next = `${target}.new`;
	const old = `${target}.old`;
	writeFileSync(next, bytes);
	try {
		chmodSync(next, 0o755);
	} catch {}
	const reported = /8gent Code v(\d+\.\d+\.\d+)/.exec(await o.probeVersion(next))?.[1];
	if (reported !== rel.version) {
		rmSync(next, { force: true });
		return `the downloaded binary reported '${reported ?? "nothing"}', not v${rel.version}; nothing changed`;
	}
	try {
		rmSync(old, { force: true });
	} catch {}
	if ((o.platform ?? process.platform) === "win32") {
		renameSync(target, old);
		try {
			renameSync(next, target);
		} catch (err) {
			renameSync(old, target);
			throw err;
		}
	} else {
		renameSync(next, target);
	}
	return null;
}

export async function runSelfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
	const o = {
		...opts,
		fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
		probeVersion: opts.probeVersion ?? defaultProbe,
		log: opts.log ?? ((line: string) => console.log(line)),
	};
	const platform = o.platform ?? process.platform;
	const arch = o.arch ?? process.arch;
	const ch = o.channel;

	if (ch === "source") {
		return {
			status: "source",
			message: "This 8gent runs from a source checkout. Update it with: git pull && bun install",
		};
	}

	try {
		if (ch === "npm") {
			const latest = await latestFromNpm(o.fetchImpl);
			const d = decideUpdate(o.currentVersion, latest);
			if (d.action === "current") return { status: "current", version: d.version, channel: ch };
			if (d.action === "refuse-downgrade")
				return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
			const c = npmInstallCommand(d.to, platform);
			o.log(`Updating ${NPM_PACKAGE} v${d.from} -> v${d.to} with npm...`);
			const code = await (o.run ?? defaultRun)(c.cmd, c.args, { shell: c.shell });
			if (code !== 0)
				return {
					status: "failed",
					channel: ch,
					message: `npm exited ${code}. Try: npm install -g ${NPM_PACKAGE}@${d.to} --force`,
				};
			return { status: "updated", from: d.from, to: d.to, channel: ch };
		}

		const asset = binaryAssetName(platform, arch);
		if (!asset)
			return { status: "failed", channel: ch, message: `no 8gent binary for ${platform}/${arch}` };
		const rel = await latestBinaryRelease(o.fetchImpl, asset, o.releasesUrl);
		if (!rel) return { status: "failed", channel: ch, message: `no release carries ${asset} yet` };
		const d = decideUpdate(o.currentVersion, rel.version);
		if (d.action === "current") return { status: "current", version: d.version, channel: ch };
		if (d.action === "refuse-downgrade")
			return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
		o.log(`Updating 8gent v${d.from} -> v${d.to} (${asset})...`);
		const err = await updateBinary(o, rel);
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
		const candidate = `${dir}/CHANGELOG.md`;
		if (existsSync(candidate) && existsSync(`${dir}/package.json`)) return candidate;
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
