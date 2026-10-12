/**
 * `8gent update`, `8gent install npm:<name>@<version>` and `8gent packages`
 * (rows A2 and G2 of the Pi parity matrix). bin/8gent.ts hands argv here and
 * prints nothing of its own, so every path is testable offline: network,
 * process and file access come in through `deps`.
 *
 * update: packages/eight/self-update.ts decides (never a lower version, the
 * channel the install came from, exact versions only). `--check` reports the
 * decision without installing; `--channel` is accepted with `--check` only,
 * so nothing can be made to install through a channel it was not installed
 * from. EIGHT_RELEASES_URL points the binary channel at another https release
 * list (self-update refuses anything that is not https).
 *
 * install npm: / packages: packages/marketplace/install.ts does the work
 * (exact version, registry integrity, no scripts, no dependencies). The
 * packages root is <home>/.8gent/packages with home from packages/core/home.ts,
 * so EIGHT_HOME moves it. EIGHT_PACKAGE_REGISTRY names another registry: https,
 * or plain http on loopback for a local test registry.
 */
import * as path from "node:path";
import { resolveHome } from "../core/home";
import {
	type InstallResult,
	installPackage,
	listPackages,
	removePackage,
	verifyPackage,
} from "../marketplace/install";
import {
	type FetchLike,
	type InstallChannel,
	type SelfUpdateOptions,
	type SelfUpdateResult,
	binaryAssetNames,
	decideUpdate,
	describeResult,
	detectChannel,
	latestBinaryRelease,
	latestFromNpm,
	runSelfUpdate,
} from "./self-update";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

// ── update ────────────────────────────────────────────────────────────

export interface UpdateCliDeps {
	currentVersion: string;
	/** import.meta.url of the running entry; decides the channel. */
	modulePath: string;
	/** true inside a compiled binary (globalThis.__EIGHT_EMBEDDED_TUI). */
	embedded: boolean;
	execPath: string;
	env?: Env;
	log?: Log;
	platform?: string;
	arch?: string;
	fetchImpl?: FetchLike;
	/** Runs a command (npm), resolves to its exit code. */
	run?: SelfUpdateOptions["run"];
	/** Tests only: the self-update engine itself. */
	selfUpdate?: (o: SelfUpdateOptions) => Promise<SelfUpdateResult>;
}

export interface UpdateArgs {
	check: boolean;
	channel?: InstallChannel;
	error?: string;
}

export const UPDATE_USAGE =
	"Usage: 8gent update [--check [--channel binary|npm]]\n" +
	"  --check    report whether a newer version exists; installs nothing\n" +
	"  --channel  with --check only: look at that channel instead of the detected one";

export function parseUpdateArgs(args: string[]): UpdateArgs {
	const out: UpdateArgs = { check: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--check" || a === "--dry-run") out.check = true;
		else if (a === "--channel" || a.startsWith("--channel=")) {
			const v = a.includes("=") ? a.slice("--channel=".length) : args[++i];
			if (v !== "binary" && v !== "npm") return { ...out, error: `--channel must be binary or npm, got "${v ?? ""}"` };
			out.channel = v;
		} else return { ...out, error: `unknown option for 8gent update: ${a}` };
	}
	if (out.channel && !out.check) {
		return { ...out, error: "--channel only applies to --check: 8gent updates through the channel it was installed from" };
	}
	return out;
}

export type UpdateCheck =
	| { status: "current"; version: string; channel: InstallChannel }
	| { status: "available"; from: string; to: string; channel: InstallChannel }
	| { status: "refused-downgrade"; from: string; to: string; channel: InstallChannel }
	| { status: "source"; message: string }
	| { status: "failed"; message: string; channel: InstallChannel };

/** The update decision for `--check`: same lookups and the same decideUpdate as a real update, no install. */
export async function checkUpdate(o: {
	currentVersion: string;
	channel: InstallChannel;
	fetchImpl: FetchLike;
	platform: string;
	arch: string;
	releasesUrl?: string;
}): Promise<UpdateCheck> {
	const ch = o.channel;
	if (ch === "source") {
		return {
			status: "source",
			message: "This 8gent runs from a source checkout. Update it with: git pull && bun install",
		};
	}
	try {
		let available: string;
		if (ch === "npm") {
			available = await latestFromNpm(o.fetchImpl);
		} else {
			const names = binaryAssetNames(o.platform, o.arch);
			if (names.length === 0)
				return { status: "failed", channel: ch, message: `no 8gent binary for ${o.platform}/${o.arch}` };
			const rel = await latestBinaryRelease(o.fetchImpl, names[0], o.releasesUrl);
			if (!rel) return { status: "failed", channel: ch, message: `no release carries ${names[0]} yet` };
			available = rel.version;
		}
		const d = decideUpdate(o.currentVersion, available);
		if (d.action === "current") return { status: "current", version: d.version, channel: ch };
		if (d.action === "refuse-downgrade")
			return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
		return { status: "available", from: d.from, to: d.to, channel: ch };
	} catch (err) {
		return { status: "failed", channel: ch, message: err instanceof Error ? err.message : String(err) };
	}
}

export function describeCheck(r: UpdateCheck): string {
	switch (r.status) {
		case "available":
			return `v${r.to} is available (this is v${r.from}, ${r.channel} channel). Run: 8gent update`;
		case "current":
			return `8gent v${r.version} is the newest ${r.channel === "npm" ? "npm" : "release"} version.`;
		case "refused-downgrade":
			return `Not updating: the newest ${r.channel === "npm" ? "npm" : "release"} version is v${r.to}, lower than this v${r.from}. 8gent never installs an older version over a newer one.`;
		case "source":
			return r.message;
		case "failed":
			return `Update check failed: ${r.message}`;
	}
}

function describeChannel(ch: InstallChannel): string {
	if (ch === "binary") return "installed as a binary (updates from GitHub releases)";
	if (ch === "npm") return "installed from npm (updates from the npm registry)";
	return "running from a source checkout";
}

/** `8gent update [args]`. Returns the exit code; prints through deps.log. */
export async function runUpdateCommand(args: string[], deps: UpdateCliDeps): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const env = deps.env ?? process.env;
	const a = parseUpdateArgs(args);
	if (a.error) {
		log(a.error);
		log(UPDATE_USAGE);
		return 2;
	}
	const detected = detectChannel({ modulePath: deps.modulePath, embedded: deps.embedded });
	const channel = a.channel ?? detected;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const releasesUrl = env.EIGHT_RELEASES_URL || undefined;
	log(`8gent v${deps.currentVersion}, ${describeChannel(detected)}.`);

	if (a.check) {
		if (a.channel && a.channel !== detected) log(`Checking the ${a.channel} channel (--channel); nothing is installed with --check.`);
		const r = await checkUpdate({ currentVersion: deps.currentVersion, channel, fetchImpl, platform, arch, releasesUrl });
		log(describeCheck(r));
		return r.status === "failed" ? 1 : 0;
	}

	const result = await (deps.selfUpdate ?? runSelfUpdate)({
		currentVersion: deps.currentVersion,
		channel,
		execPath: deps.execPath,
		platform,
		arch,
		fetchImpl,
		run: deps.run,
		releasesUrl,
		log,
	});
	log(describeResult(result));
	if (result.status === "updated") {
		log(`Updated to v${result.to}. Run 8gent, then /changelog to see what changed.`);
	}
	return result.status === "failed" ? 1 : 0;
}

// ── install npm: / packages ───────────────────────────────────────────

export interface PackagesCliDeps {
	env?: Env;
	log?: Log;
	fetch?: typeof fetch;
	now?: Date;
}

/** <home>/.8gent/packages, with home from packages/core/home.ts (EIGHT_HOME first). */
export function packagesRoot(env: Env = process.env): string {
	return path.join(resolveHome(env), ".8gent", "packages");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * EIGHT_PACKAGE_REGISTRY, when set. Loopback http is passed through with the
 * flag install.ts needs for it; any other http registry is left for install.ts
 * to refuse, so the refusal has one wording.
 */
export function registryFromEnv(env: Env = process.env): { registry?: string; allowLoopbackHttp?: boolean } {
	const r = env.EIGHT_PACKAGE_REGISTRY;
	if (!r) return {};
	let loopback = false;
	try {
		const u = new URL(r);
		loopback = u.protocol === "http:" && LOOPBACK.has(u.hostname);
	} catch {
		// install.ts reports the bad URL
	}
	return loopback ? { registry: r, allowLoopbackHttp: true } : { registry: r };
}

export function describeInstall(res: InstallResult): string[] {
	const p = res.pkg;
	const out: string[] = [];
	out.push(
		res.alreadyInstalled
			? `${p.name}@${p.version} is already installed and verified: ${p.dir}`
			: `Installed ${p.name}@${p.version} into ${p.dir}`,
	);
	out.push(`Pinned by registry integrity: ${p.integrity}`);
	out.push("Package scripts were not run.");
	if (res.dependencies.length > 0) {
		out.push(`Not installed, declared as dependencies: ${res.dependencies.join(", ")}`);
	}
	if (res.contributes !== undefined) out.push(`Contributes: ${JSON.stringify(res.contributes)}`);
	for (const w of res.warnings) out.push(`Warning: ${w}`);
	return out;
}

/** `8gent install npm:<name>@<version>`. Returns the exit code. */
export async function runInstallNpmCommand(spec: string, deps: PackagesCliDeps = {}): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const env = deps.env ?? process.env;
	try {
		const res = await installPackage(spec, {
			root: packagesRoot(env),
			fetch: deps.fetch,
			now: deps.now,
			...registryFromEnv(env),
		});
		for (const line of describeInstall(res)) log(line);
		return 0;
	} catch (err) {
		log(`Install refused: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

export const PACKAGES_USAGE =
	"Usage: 8gent packages [list] | remove <name> | verify <name>\n" +
	"  Install one with: 8gent install npm:<name>@<version>";

/** `8gent packages [list|remove <name>|verify <name>]`. Returns the exit code. */
export function runPackagesCommand(args: string[], deps: PackagesCliDeps = {}): number {
	const log = deps.log ?? ((line: string) => console.log(line));
	const root = packagesRoot(deps.env ?? process.env);
	const sub = args[0] ?? "list";
	const name = args[1];
	try {
		if (sub === "list" || sub === "ls") {
			const pkgs = listPackages({ root });
			if (pkgs.length === 0) {
				log(`No packages installed under ${root}.`);
				log("Install one with: 8gent install npm:<name>@<version>");
				return 0;
			}
			for (const p of pkgs) log(`${p.name}@${p.version}  ${p.dir}  (installed ${p.installedAt})`);
			return 0;
		}
		if (sub === "remove" || sub === "rm" || sub === "uninstall") {
			if (!name) {
				log(PACKAGES_USAGE);
				return 2;
			}
			if (!removePackage(name, { root })) {
				log(`${name} is not installed.`);
				return 1;
			}
			log(`Removed ${name}.`);
			return 0;
		}
		if (sub === "verify") {
			if (!name) {
				log(PACKAGES_USAGE);
				return 2;
			}
			const v = verifyPackage(name, { root });
			log(v.ok ? `${name}: files match the pin.` : `${name}: ${v.error}`);
			return v.ok ? 0 : 1;
		}
		log(PACKAGES_USAGE);
		return 2;
	} catch (err) {
		log(`packages ${sub} failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
