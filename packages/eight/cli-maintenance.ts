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
	latestForNpmChannel,
	npmPrefixFromModulePath,
	runSelfUpdate,
} from "./self-update";
import { type ExecFn, runSourceUpdate } from "./source-update";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

// ── interactive gate ──────────────────────────────────────────────────

/**
 * Is a person at a terminal? True only when stdin AND stdout are both TTYs, so
 * a pipe or redirect on either side is not a person. Same rule as
 * `8gent ext enable` (packages/extensions/ext-cli.ts on the pi-l5 branch):
 * no env var or flag overrides it; only tests inject a value, through
 * `deps.interactive`.
 */
export function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** The refusal line for a command that installs or removes code without a person at a terminal. */
export function interactiveRefusal(command: string): string {
	return `Refused: ${command} needs a person at an interactive terminal. Run it yourself in a terminal: ${command}`;
}

// ── update ────────────────────────────────────────────────────────────

export interface UpdateCliDeps {
	currentVersion: string;
	/** import.meta.url of the running entry; decides the channel. */
	modulePath: string;
	/** true inside a compiled binary (the module path is in Bun's virtual filesystem). */
	embedded: boolean;
	execPath: string;
	env?: Env;
	log?: Log;
	platform?: string;
	arch?: string;
	fetchImpl?: FetchLike;
	/** Runs a command (npm), resolves to its exit code. */
	run?: SelfUpdateOptions["run"];
	/** Is a person at a terminal? Default: stdin and stdout are both TTYs. A real update requires it. */
	interactive?: boolean;
	/** Tests only: the self-update engine itself. */
	selfUpdate?: (o: SelfUpdateOptions) => Promise<SelfUpdateResult>;
	/** Tests only: exec/path hooks for the source-checkout update (git and bun). */
	sourceExec?: ExecFn;
	sourceIsFile?: (p: string) => boolean;
	sourceHasGit?: (dir: string) => boolean;
	sourceFileExists?: (p: string) => boolean;
	/** Home directory used to find a sibling 8gent Browser checkout. */
	homeDir?: string;
	/** y/N prompt for a source update (default: the terminal). The TUI passes a two-step confirm. */
	confirm?: (question: string, o: { strict: boolean }) => Promise<boolean>;
	/** Called once with the outcome of a real update (the TUI uses it to resume the session). */
	report?: (o: { updated: boolean; to?: string }) => void;
}

export interface UpdateArgs {
	check: boolean;
	force?: boolean;
	yes?: boolean;
	channel?: InstallChannel;
	error?: string;
}

export const UPDATE_USAGE =
	"Usage: 8gent update [--check [--channel binary|npm]] [--force] [--yes]\n" +
	"  --yes      source checkout only: skip the y/N for a known origin (an unknown origin always asks)\n" +
	"  --check    report whether a newer version exists; installs nothing\n" +
	"  --force    source checkout only: save local changes or commits to a backup branch, then move to origin/main\n" +
	"  --channel  with --check only: look at that channel instead of the detected one";

export function parseUpdateArgs(args: string[]): UpdateArgs {
	const out: UpdateArgs = { check: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--check" || a === "--dry-run") out.check = true;
		else if (a === "--force") out.force = true;
		else if (a === "--yes" || a === "-y") out.yes = true;
		else if (a === "--channel" || a.startsWith("--channel=")) {
			const v = a.includes("=") ? a.slice("--channel=".length) : args[++i];
			if (v !== "binary" && v !== "npm")
				return { ...out, error: `--channel must be binary or npm, got "${v ?? ""}"` };
			out.channel = v;
		} else return { ...out, error: `unknown option for 8gent update: ${a}` };
	}
	if (out.channel && !out.check) {
		return {
			...out,
			error:
				"--channel only applies to --check: 8gent updates through the channel it was installed from",
		};
	}
	if (out.force && out.check) return { ...out, error: "--force cannot be combined with --check" };
	return out;
}

export type UpdateCheck =
	| { status: "current"; version: string; channel: InstallChannel }
	| { status: "available"; from: string; to: string; channel: InstallChannel }
	| { status: "refused-downgrade"; from: string; to: string; channel: InstallChannel }
	| { status: "source"; message: string }
	| { status: "failed"; message: string; channel: InstallChannel };

const SOURCE_UPDATE_HINT = "This 8gent runs from a source checkout. Update it with: 8gent update";
const RESUME_HINT = "Run 8gent --resume to pick up where you left off.";

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
			message: SOURCE_UPDATE_HINT,
		};
	}
	try {
		let available: string;
		if (ch === "npm") {
			available = (await latestForNpmChannel(o.fetchImpl, o.releasesUrl)).version;
		} else {
			const names = binaryAssetNames(o.platform, o.arch);
			if (names.length === 0)
				return {
					status: "failed",
					channel: ch,
					message: `no 8gent binary for ${o.platform}/${o.arch}`,
				};
			const rel = await latestBinaryRelease(o.fetchImpl, names[0], o.releasesUrl);
			if (!rel)
				return { status: "failed", channel: ch, message: `no release carries ${names[0]} yet` };
			available = rel.version;
		}
		const d = decideUpdate(o.currentVersion, available);
		if (d.action === "current") return { status: "current", version: d.version, channel: ch };
		if (d.action === "refuse-downgrade")
			return { status: "refused-downgrade", from: d.from, to: d.to, channel: ch };
		return { status: "available", from: d.from, to: d.to, channel: ch };
	} catch (err) {
		return {
			status: "failed",
			channel: ch,
			message: err instanceof Error ? err.message : String(err),
		};
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
	if (ch === "npm") return "installed with npm (updates from the GitHub release package)";
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
	const channel: InstallChannel = a.channel ?? detected;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const releasesUrl = env.EIGHT_RELEASES_URL || undefined;
	log(`8gent v${deps.currentVersion}, ${describeChannel(detected)}.`);

	const platformEarly = platform;
	if (channel === "source") {
		if (a.force && !a.check)
			log("--force: local changes or commits will be saved to a backup branch first.");
		if (!a.check && !(deps.interactive ?? isInteractiveTerminal())) {
			log(interactiveRefusal("8gent update"));
			return 1;
		}
		let updated = false;
		const code = await runSourceUpdate(
			{
				modulePath: deps.modulePath,
				env,
				platform: platformEarly,
				home: deps.homeDir,
				log,
				exec: deps.sourceExec,
				isFile: deps.sourceIsFile,
				hasGit: deps.sourceHasGit,
				fileExists: deps.sourceFileExists,
				confirm: deps.confirm,
			},
			{ force: Boolean(a.force), checkOnly: a.check, yes: a.yes },
			(o) => {
				updated = o.updated;
				deps.report?.(o);
			},
		);
		if (updated && code === 0) log(RESUME_HINT);
		return code;
	}
	if (a.force || a.yes) {
		log("--force and --yes only apply to a source checkout.");
		return 2;
	}

	if (a.check) {
		if (a.channel && a.channel !== detected)
			log(`Checking the ${a.channel} channel (--channel); nothing is installed with --check.`);
		const r = await checkUpdate({
			currentVersion: deps.currentVersion,
			channel,
			fetchImpl,
			platform,
			arch,
			releasesUrl,
		});
		log(describeCheck(r));
		return r.status === "failed" ? 1 : 0;
	}

	// A real update downloads and replaces the running 8gent (or runs npm), so,
	// like `ext enable`, it needs a person at a terminal. --check stays open.
	if (!(deps.interactive ?? isInteractiveTerminal())) {
		log(interactiveRefusal("8gent update"));
		return 1;
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
		npmPrefix: npmPrefixFromModulePath(deps.modulePath, platform),
		log,
	});
	if (result.status === "current") log("Already up to date.");
	log(describeResult(result));
	if (result.status === "updated") {
		log(`Updated to v${result.to}. Run 8gent, then /changelog to see what changed.`);
		log(RESUME_HINT);
		deps.report?.({ updated: true, to: `v${result.to}` });
	}
	return result.status === "failed" ? 1 : 0;
}

// ── install npm: / packages ───────────────────────────────────────────

export interface PackagesCliDeps {
	env?: Env;
	log?: Log;
	fetch?: typeof fetch;
	now?: Date;
	/** Is a person at a terminal? Default: stdin and stdout are both TTYs. Install and remove require it. */
	interactive?: boolean;
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
export function registryFromEnv(env: Env = process.env): {
	registry?: string;
	allowLoopbackHttp?: boolean;
} {
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
export async function runInstallNpmCommand(
	spec: string,
	deps: PackagesCliDeps = {},
): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const env = deps.env ?? process.env;
	if (!(deps.interactive ?? isInteractiveTerminal())) {
		log(interactiveRefusal(`8gent install ${spec}`));
		return 1;
	}
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
			if (!(deps.interactive ?? isInteractiveTerminal())) {
				log(interactiveRefusal(`8gent packages remove ${name}`));
				return 1;
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
