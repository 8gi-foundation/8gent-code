/**
 * `8gent update` for a source checkout (and a sibling 8gent Browser checkout).
 *
 * Before this, a source install was only told to `git pull`. Now the update
 * runs, safely:
 *
 *   - Tracked local changes stop it (never a silent reset of user edits).
 *     `--force` first saves the work to a backup branch, then resets.
 *   - It fetches the checkout's OWN `origin` (forge or GitHub, whatever the
 *     clone has) and only fast-forwards. A diverged history is refused.
 *   - It then runs `bun install` (frozen lockfile when one exists), and for
 *     8gent Browser also `bun run build`.
 *
 * Safety: git and bun run through execFile with fixed argv arrays, never a
 * shell; every call has a timeout; executables resolve from absolute PATH
 * entries only; no remote is ever added or changed; every command runs with
 * its cwd set to one of the two checkouts, after checking that the directory
 * really is the top of a git work tree. No POSIX-only env is set, so it runs
 * on Windows. Process and file access are injected so every path is testable.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { safeBunFlags } from "../core/bun-flags";
import { sanitizeForDisplay } from "./changelog-view";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export type ExecFn = (
	file: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<ExecResult>;

const T_LOCAL = 30_000;
const T_FETCH = 120_000;
const T_INSTALL = 600_000;

// ── scrubbed environment for install and build ───────────────────────

/**
 * Names (case-insensitive) that bun install / bun run build need to find the
 * toolchain, cache and network. No API keys, tokens or cloud credentials.
 */
const ENV_KEEP = new Set(
	[
		"PATH",
		"HOME",
		"USERPROFILE",
		"TMPDIR",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TERM",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"APPDATA",
		"LOCALAPPDATA",
		"PROGRAMDATA",
		"PROGRAMFILES",
		"PROGRAMFILES(X86)",
		"HOMEDRIVE",
		"HOMEPATH",
		"USERNAME",
		"BUN_INSTALL",
		"BUN_INSTALL_CACHE_DIR",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	].map((k) => k.toUpperCase()),
);

/** The minimal env a lifecycle script of a freshly pulled checkout gets. */
export function scrubbedEnv(base: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) {
		if (typeof v === "string" && ENV_KEEP.has(k.toUpperCase())) out[k] = v;
	}
	return out;
}

// ── origin allowlist ─────────────────────────────────────────────────

export interface ParsedOrigin {
	host: string;
	/** lowercased owner/repo without a .git suffix */
	repoPath: string;
	scheme: string;
}

/** https://h/o/r(.git), ssh://git@h[:p]/o/r, git@h:o/r(.git). Anything else is null. */
export function parseOrigin(url: string): ParsedOrigin | null {
	const u = url.trim();
	const strip = (p: string) =>
		p
			.replace(/^\/+/, "")
			.replace(/\.git$/i, "")
			.replace(/\/+$/, "")
			.toLowerCase();
	const scp = /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+):(?!\/\/)(?!\d+\/)([^\s]+)$/.exec(u);
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u))
		return { host: scp[1].toLowerCase(), repoPath: strip(scp[2]), scheme: "ssh" };
	try {
		const x = new URL(u);
		if (!["https:", "http:", "ssh:"].includes(x.protocol)) return null;
		const host = x.port ? `${x.hostname}:${x.port}` : x.hostname;
		return {
			host: host.toLowerCase(),
			repoPath: strip(decodeURIComponent(x.pathname)),
			scheme: x.protocol.slice(0, -1),
		};
	} catch {
		return null;
	}
}

/**
 * Is this origin one we expect for `repo` (8gent-code or 8gent-browser)?
 * GitHub: only 8gi-foundation/<repo>, over https or ssh. Forge: any owner's <repo>
 * on the host named by EIGHT_FORGE_HOST (host or host:port), https, http or ssh.
 */
export function originTrusted(
	url: string,
	repo: string,
	forgeHost?: string,
	forgeOwner = "8gi-foundation",
): boolean {
	const o = parseOrigin(url);
	if (!o) return false;
	if (o.host === "github.com" && (o.scheme === "https" || o.scheme === "ssh"))
		return o.repoPath === `8gi-foundation/${repo}`;
	const fh = forgeHost
		?.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, "")
		.replace(/\/+$/, "");
	if (fh && o.host === fh && (o.scheme === "https" || o.scheme === "ssh"))
		return o.repoPath === `${(forgeOwner || "8gi-foundation").trim().toLowerCase()}/${repo}`;
	return false;
}

/** y/N on the terminal; anything but y/yes is no. No terminal means no. */
export async function defaultConfirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	const { createInterface } = await import("node:readline");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const ans: string = await new Promise((res) => rl.question(`${question} [y/N] `, res));
		return /^y(es)?$/i.test(ans.trim());
	} finally {
		rl.close();
	}
}

/** Default exec: execFile, no shell, timeout, no console window on Windows. */
export const defaultExec: ExecFn = (file, args, opts) =>
	new Promise((resolve) => {
		execFile(
			file,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
				windowsHide: true,
				shell: false,
				// Never wait on a credential prompt; set the same on every OS.
				env: (opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" }) as NodeJS.ProcessEnv,
			},
			(err, stdout, stderr) => {
				if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
				const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
				const timedOut = Boolean(e.killed && e.signal);
				resolve({
					code: typeof e.code === "number" ? e.code : -1,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? "") || e.message,
					timedOut,
				});
			},
		);
	});

// ── paths and executables ─────────────────────────────────────────────

type PathLib = typeof nodePath.posix;
const lib = (platform: string): PathLib => (platform === "win32" ? nodePath.win32 : nodePath.posix);

/** Same directory? Windows paths compare case-insensitively and ignore \ vs /. */
export function samePath(a: string, b: string, platform: string): boolean {
	const p = lib(platform);
	const norm = (x: string) => {
		let n = p.normalize(x).replace(/[\\/]+$/, "");
		if (platform === "win32") n = n.replace(/\//g, "\\").toLowerCase();
		return n;
	};
	return norm(a) === norm(b);
}

/**
 * Resolve `name` (git, bun) from the absolute entries of PATH only. A relative
 * or empty entry means "the current directory" and is skipped, so a planted
 * git.exe in a project folder is never run. Windows looks for `<name>.exe`
 * (execFile without a shell cannot run .cmd shims).
 */
export function resolveExecutable(
	name: string,
	o: {
		env: Record<string, string | undefined>;
		platform: string;
		isFile?: (p: string) => boolean;
	},
): string | null {
	const p = lib(o.platform);
	const isFile =
		o.isFile ??
		((f: string) => {
			try {
				return statSync(f).isFile();
			} catch {
				return false;
			}
		});
	const key = Object.keys(o.env).find((k) =>
		o.platform === "win32" ? k.toLowerCase() === "path" : k === "PATH",
	);
	const raw = key ? (o.env[key] ?? "") : "";
	const delim = o.platform === "win32" ? ";" : ":";
	const file = o.platform === "win32" && !/\.(exe|com)$/i.test(name) ? `${name}.exe` : name;
	for (const entry of raw.split(delim)) {
		const dir = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!dir || !p.isAbsolute(dir)) continue;
		const full = p.join(dir, file);
		if (isFile(full)) return full;
	}
	return null;
}

/** Turn import.meta.url / a path into a plain filesystem path (also file:///C:/x on Windows). */
export function modulePathToFs(modulePath: string): string {
	let s = modulePath;
	if (s.startsWith("file://")) {
		s = s.slice("file://".length);
		try {
			s = decodeURIComponent(s);
		} catch {}
		if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
	}
	return s;
}

/** The nearest ancestor of the running module that has a .git entry. */
export function findCheckoutRoot(
	modulePath: string,
	platform: string,
	hasGit: (dir: string) => boolean = (d) => existsSync(lib(platform).join(d, ".git")),
): string | null {
	const p = lib(platform);
	const fsPath = modulePathToFs(modulePath);
	let dir = p.dirname(platform === "win32" ? fsPath.replace(/\//g, "\\") : fsPath);
	for (let i = 0; i < 40; i++) {
		if (hasGit(dir)) return dir;
		const up = p.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
	return null;
}

/**
 * Sibling 8gent Browser source checkouts: EIGHT_BROWSER_SRC (absolute), then
 * <home>/8gent-browser. Only directories with a .git entry; never the code
 * checkout itself.
 */
export function findBrowserCheckout(o: {
	env: Record<string, string | undefined>;
	home: string;
	platform: string;
	codeRoot: string;
	hasGit?: (dir: string) => boolean;
}): { dir: string | null; looked: string[]; note?: string } {
	const p = lib(o.platform);
	const hasGit = o.hasGit ?? ((d: string) => existsSync(p.join(d, ".git")));
	const looked: string[] = [];
	let note: string | undefined;
	const cands: string[] = [];
	const fromEnv = o.env.EIGHT_BROWSER_SRC?.trim();
	if (fromEnv) {
		if (p.isAbsolute(fromEnv)) cands.push(fromEnv);
		else note = `EIGHT_BROWSER_SRC is not an absolute path, ignored: ${fromEnv}`;
	}
	if (o.home) cands.push(p.join(o.home, "8gent-browser"));
	for (const c of cands) {
		looked.push(c);
		if (samePath(c, o.codeRoot, o.platform)) continue;
		if (hasGit(c)) return { dir: c, looked, note };
	}
	return { dir: null, looked, note };
}

// ── one checkout ──────────────────────────────────────────────────────

export interface CheckoutDeps {
	exec: ExecFn;
	git: string;
	bun: string;
	platform: string;
	/** Does <dir>/<file> exist? (lockfile test) */
	fileExists: (path: string) => boolean;
	now: () => Date;
	/** Environment to scrub for bun install / bun run build. Default: process.env. */
	baseEnv?: Record<string, string | undefined>;
	/** y/N. `strict` = the origin is not on the allowlist, so --yes does not skip it. Default: no. */
	confirm?: (question: string, o: { strict: boolean }) => Promise<boolean>;
	/** EIGHT_FORGE_HOST: the forge's host (or host:port) whose <repo> origins are trusted. */
	forgeHost?: string;
	/** EIGHT_FORGE_OWNER: the one owner trusted on the forge host (default 8gi-foundation). */
	forgeOwner?: string;
}

export type CheckoutStatus =
	| "updated"
	| "current"
	| "ahead-local"
	| "available"
	| "refused"
	| "declined"
	| "failed";

export interface CheckoutReport {
	status: CheckoutStatus;
	from?: string;
	to?: string;
	/** Commit subjects between from and to, newest first. */
	changes?: string[];
	backupBranch?: string;
	message?: string;
	/** For "available": a plain fast-forward from `from` to `to` is possible. */
	canFastForward?: boolean;
}

export interface UpdateCheckoutOptions {
	dir: string;
	force: boolean;
	checkOnly: boolean;
	/** Also run `bun run build` after install (8gent Browser). */
	build: boolean;
	/** Which repo this is: decides the origin allowlist. */
	repo: "8gent-code" | "8gent-browser";
	/** Skip the y/N for a trusted origin (never for an untrusted one). */
	yes?: boolean;
}

/**
 * bun install / bun run build run a freshly pulled checkout's own scripts, so
 * they get no ambient secrets (scrubbed env) and no cwd bunfig.toml or .env
 * (the same flags every other 8gent bun child gets).
 */
export function bunStep(d: CheckoutDeps, dir: string, args: string[]): Promise<ExecResult> {
	const flags = safeBunFlags(d.platform as NodeJS.Platform);
	return d.exec(d.bun, [...flags, ...args], {
		cwd: dir,
		timeoutMs: T_INSTALL,
		env: scrubbedEnv(d.baseEnv ?? process.env),
	});
}

/** Untracked paths that a checkout of `tree` (ls-tree names) would overwrite or collide with. */
export function untrackedClashes(untrackedOut: string, treeOut: string): string[] {
	const lines = (x: string) => x.split(/\r?\n/).filter(Boolean);
	const files = new Set(lines(treeOut));
	const dirs = new Set<string>();
	for (const f of files) {
		const parts = f.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	return lines(untrackedOut).filter((u) => {
		if (files.has(u) || dirs.has(u)) return true;
		const parts = u.split("/");
		for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/"))) return true;
		return false;
	});
}

const short = (sha: string) => sha.trim().slice(0, 7);
const lastLines = (s: string, n = 8) => s.trim().split(/\r?\n/).slice(-n).join("\n");

/** Fetch only this checkout's own configured origin. No remote is added or changed. */
export async function updateCheckout(
	d: CheckoutDeps,
	o: UpdateCheckoutOptions,
): Promise<CheckoutReport> {
	const g = (args: string[], timeoutMs = T_LOCAL) =>
		// protocol.ext.allow=never: a poisoned remote URL cannot run a command through git's ext:: transport.
		d.exec(d.git, ["-c", "protocol.ext.allow=never", ...args], { cwd: o.dir, timeoutMs });
	const fail = (message: string): CheckoutReport => ({ status: "failed", message });

	const top = await g(["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return fail(`not a git checkout: ${o.dir}`);
	const real = (x: string) => {
		try {
			return realpathSync(x);
		} catch {
			return x;
		}
	};
	// Symlinked temp or home directories (macOS /tmp, /var) still count as the same directory.
	const sameDir =
		samePath(top.stdout.trim(), o.dir, d.platform) ||
		samePath(real(top.stdout.trim()), real(o.dir), d.platform);
	if (!sameDir)
		return fail(`${o.dir} is inside another git work tree (${top.stdout.trim()}); not touching it`);

	const head = await g(["rev-parse", "HEAD"]);
	if (head.code !== 0) return fail(`cannot read HEAD: ${lastLines(head.stderr, 2)}`);
	const from = head.stdout.trim();

	const branch = await g(["symbolic-ref", "--short", "-q", "HEAD"]);
	if (branch.code !== 0 || branch.stdout.trim() !== "main")
		return {
			status: "refused",
			from,
			message: `this checkout is on ${branch.code === 0 ? `branch ${branch.stdout.trim()}` : "a detached HEAD"}, not main. Switch with: git switch main`,
		};

	const remote = await g(["remote", "get-url", "origin"]);
	if (remote.code !== 0)
		return fail("this checkout has no 'origin' remote; 8gent will not add one");

	const dirty = await g(["status", "--porcelain", "--untracked-files=no"]);
	if (dirty.code !== 0) return fail(`git status failed: ${lastLines(dirty.stderr, 2)}`);
	const isDirty = dirty.stdout.trim().length > 0;
	if (isDirty && o.force && !o.checkOnly) {
		// A half-finished merge has no honest snapshot; never reset over it.
		const unmerged = await g(["ls-files", "--unmerged"]);
		if (unmerged.code !== 0 || unmerged.stdout.trim().length > 0)
			return {
				status: "refused",
				from,
				message:
					"this checkout has unmerged paths (a merge or rebase is unfinished), so there is no safe snapshot to back up. Nothing was changed. Finish or abort it (git merge --abort / git rebase --abort), then run 8gent update again",
			};
	}
	if (isDirty && !o.force && !o.checkOnly)
		return {
			status: "refused",
			from,
			message:
				"local changes to tracked files:\n" +
				dirty.stdout
					.trim()
					.split(/\r?\n/)
					.slice(0, 10)
					.map((l) => `  ${l}`)
					.join("\n") +
				"\nNothing was changed. Commit or discard them, or run: 8gent update --force (saves them to a backup branch first)",
		};

	const fetch = await g(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], T_FETCH);
	if (fetch.code !== 0)
		return fail(
			fetch.timedOut
				? "git fetch timed out"
				: `git fetch origin failed: ${lastLines(fetch.stderr, 3)}`,
		);
	const tip = await g(["rev-parse", "refs/remotes/origin/main"]);
	if (tip.code !== 0) return fail("origin has no main branch");
	const to = tip.stdout.trim();

	if (to === from) return { status: "current", from, to };

	const ahead = await g(["merge-base", "--is-ancestor", to, from]);
	if (ahead.code === 0)
		return {
			status: "ahead-local",
			from,
			to,
			message: "this checkout already contains origin/main",
		};

	const ff = await g(["merge-base", "--is-ancestor", from, to]);
	if (ff.code !== 0 && ff.code !== 1)
		return fail(`cannot compare history: ${lastLines(ff.stderr, 2)}`);
	const canFastForward = ff.code === 0;

	if (o.checkOnly) {
		const cnt = await g(["rev-list", "--count", `${from}..${to}`]);
		const n = cnt.code === 0 ? cnt.stdout.trim() : "?";
		return {
			status: "available",
			from,
			to,
			canFastForward,
			message: canFastForward
				? `origin/main is ${n} commit${n === "1" ? "" : "s"} ahead`
				: "origin/main has moved and this checkout has diverged from it",
		};
	}

	if (!canFastForward && !o.force)
		return {
			status: "refused",
			from,
			to,
			message:
				"this checkout has commits that are not on origin/main (history diverged), so a fast-forward is not possible. Nothing was changed. To keep your commits on a backup branch and move to origin/main, run: 8gent update --force",
		};

	const needReset = isDirty || !canFastForward;

	// What would come in, shown before anything moves or runs.
	const incoming = await g(["log", "--format=%h %s", "-n", "30", `${from}..${to}`]);
	const incomingLines =
		incoming.code === 0
			? sanitizeForDisplay(incoming.stdout)
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
			: [];
	const originUrl = sanitizeForDisplay(remote.stdout.trim());
	const trusted = originTrusted(originUrl, o.repo, d.forgeHost, d.forgeOwner);
	if (!trusted || !o.yes) {
		const q =
			`${trusted ? "" : `WARNING: origin ${originUrl} is not a known ${o.repo} source.\n`}` +
			`Origin: ${originUrl}\nIncoming commits (${short(from)} -> ${short(to)}):\n` +
			`${incomingLines.map((l) => `  ${l}`).join("\n") || "  (none listed)"}\n` +
			`${o.build ? "This will run bun install and bun run build from that checkout." : "This will run bun install from that checkout."}\nApply?`;
		const ok = d.confirm ? await d.confirm(q, { strict: !trusted }) : false;
		if (!ok)
			return {
				status: "declined",
				from,
				to,
				message: `not confirmed; nothing was changed${d.confirm ? "" : " (run 8gent update in a terminal, or add --yes for a known origin)"}`,
			};
	}

	let backupBranch: string | undefined;
	if (needReset) {
		// reset --hard overwrites untracked files that the new tree also has. Refuse rather than lose them.
		const [untracked, tree] = await Promise.all([
			g(["ls-files", "--others", "--exclude-standard"]),
			g(["ls-tree", "-r", "--name-only", to]),
		]);
		if (untracked.code !== 0 || tree.code !== 0)
			return fail("could not check untracked files before resetting; nothing was changed");
		const clash = untrackedClashes(untracked.stdout, tree.stdout);
		if (clash.length > 0)
			return {
				status: "refused",
				from,
				to,
				message: `untracked files would be overwritten by origin/main:\n${clash
					.slice(0, 10)
					.map((c) => `  ${c}`)
					.join(
						"\n",
					)}\nNothing was changed. Move or delete them, then run 8gent update --force again`,
			};
		// --force: save the tracked changes first. `stash create` writes a commit of them
		// without touching the stash list or the work tree. Untracked files are never touched
		// by a reset, so they stay where they are.
		let snapSha = "";
		if (isDirty) {
			const snap = await g([
				"-c",
				"user.name=8gent update",
				"-c",
				"user.email=update@8gent.invalid",
				"stash",
				"create",
				"8gent update backup",
			]);
			snapSha = snap.code === 0 ? snap.stdout.trim() : "";
			if (!snapSha)
				return fail(
					"could not snapshot your local changes, so nothing was reset; nothing was changed",
				);
		}
		const iso = d.now().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
		backupBranch = `backup/8gent-update-${iso}-${short(from)}`;
		const br = await g(["branch", backupBranch, snapSha || from]);
		if (br.code !== 0)
			return fail(`could not create backup branch ${backupBranch}: ${lastLines(br.stderr, 2)}`);
	}

	const move = needReset
		? await g(["reset", "--hard", to])
		: await g(["merge", "--ff-only", "refs/remotes/origin/main"]);
	if (move.code !== 0)
		return {
			status: "failed",
			from,
			to,
			backupBranch,
			message: `${needReset ? "reset" : "fast-forward"} failed: ${lastLines(move.stderr, 3)}`,
		};

	const changes = incomingLines;

	const lock = ["bun.lock", "bun.lockb"].some((f) => d.fileExists(lib(d.platform).join(o.dir, f)));
	const install = await bunStep(d, o.dir, lock ? ["install", "--frozen-lockfile"] : ["install"]);
	if (install.code !== 0)
		return {
			status: "failed",
			from,
			to,
			changes,
			backupBranch,
			message: `updated to ${short(to)} but ${install.timedOut ? "bun install timed out" : "bun install failed"}:\n${lastLines(install.stderr || install.stdout)}`,
		};
	if (o.build) {
		const build = await bunStep(d, o.dir, ["run", "build"]);
		if (build.code !== 0)
			return {
				status: "failed",
				from,
				to,
				changes,
				backupBranch,
				message: `updated to ${short(to)} but ${build.timedOut ? "bun run build timed out" : "bun run build failed"}:\n${lastLines(build.stderr || build.stdout)}`,
			};
	}
	return { status: "updated", from, to, changes, backupBranch };
}

// ── the whole command ────────────────────────────────────────────────

export interface SourceUpdateDeps {
	modulePath: string;
	env: Record<string, string | undefined>;
	platform: string;
	home?: string;
	log: (line: string) => void;
	exec?: ExecFn;
	isFile?: (p: string) => boolean;
	hasGit?: (dir: string) => boolean;
	fileExists?: (p: string) => boolean;
	now?: () => Date;
	/** y/N prompt. Default: the terminal; no terminal means no. */
	confirm?: CheckoutDeps["confirm"];
}

function describe(name: string, r: CheckoutReport): string[] {
	const out: string[] = [];
	switch (r.status) {
		case "updated":
			out.push(`${name} updated ${short(r.from ?? "")} -> ${short(r.to ?? "")}`);
			if (r.backupBranch) out.push(`  your previous state is saved on branch ${r.backupBranch}`);
			if (r.changes?.length) {
				out.push("  changes:");
				for (const c of r.changes) out.push(`    ${c}`);
			}
			break;
		case "current":
			out.push(`${name} is up to date at ${short(r.to ?? "")}`);
			break;
		case "ahead-local":
			out.push(`${name} is up to date (${r.message})`);
			break;
		case "available":
			out.push(
				`${name}: ${r.message} (${short(r.from ?? "")} -> ${short(r.to ?? "")}). Run: 8gent update`,
			);
			break;
		case "refused":
			out.push(`${name} not updated: ${r.message}`);
			break;
		case "declined":
			out.push(`${name} not updated: ${r.message}`);
			break;
		case "failed":
			out.push(`${name} update failed: ${r.message}`);
			if (r.backupBranch) out.push(`  your previous state is saved on branch ${r.backupBranch}`);
			break;
	}
	return out;
}

/**
 * For the startup notice: is origin/main ahead of this checkout? Fetches the
 * checkout's own origin (updates refs/remotes/origin/main only), then compares.
 * Null on any error, when up to date, or when a fast-forward is not possible.
 */
export async function checkSourceAhead(
	deps: Pick<SourceUpdateDeps, "modulePath" | "env" | "platform" | "exec" | "isFile" | "hasGit">,
): Promise<{ from: string; to: string } | null> {
	const { platform, env } = deps;
	const root = findCheckoutRoot(deps.modulePath, platform, deps.hasGit);
	const git = resolveExecutable("git", { env, platform, isFile: deps.isFile });
	if (!root || !git) return null;
	const d: CheckoutDeps = {
		exec: deps.exec ?? defaultExec,
		git,
		bun: "bun",
		platform,
		fileExists: () => false,
		now: () => new Date(),
	};
	const r = await updateCheckout(d, {
		dir: root,
		force: false,
		checkOnly: true,
		build: false,
		repo: "8gent-code",
	});
	return r.status === "available" && r.canFastForward && r.from && r.to
		? { from: r.from, to: r.to }
		: null;
}

/** Returns the exit code: 0 when every checkout is current or updated, 1 otherwise. */
export async function runSourceUpdate(
	deps: SourceUpdateDeps,
	opts: { force: boolean; checkOnly: boolean; yes?: boolean },
	report?: (o: { updated: boolean; to?: string }) => void,
): Promise<number> {
	const { log, platform, env } = deps;
	const root = findCheckoutRoot(deps.modulePath, platform, deps.hasGit);
	if (!root) {
		log("Update failed: could not find the git checkout this 8gent runs from.");
		return 1;
	}
	const git = resolveExecutable("git", { env, platform, isFile: deps.isFile });
	if (!git) {
		log("Update failed: git was not found in an absolute PATH entry.");
		return 1;
	}
	const needBun = !opts.checkOnly;
	const bun = resolveExecutable("bun", { env, platform, isFile: deps.isFile });
	if (needBun && !bun) {
		log("Update failed: bun was not found in an absolute PATH entry.");
		return 1;
	}
	const d: CheckoutDeps = {
		exec: deps.exec ?? defaultExec,
		git,
		bun: bun ?? "bun",
		platform,
		fileExists: deps.fileExists ?? ((f) => existsSync(f)),
		now: deps.now ?? (() => new Date()),
		baseEnv: env,
		forgeHost: env.EIGHT_FORGE_HOST,
		forgeOwner: env.EIGHT_FORGE_OWNER,
		confirm: deps.confirm ?? ((q) => defaultConfirm(q)),
	};

	let bad = false;
	const code = await updateCheckout(d, {
		dir: root,
		force: opts.force,
		checkOnly: opts.checkOnly,
		build: false,
		repo: "8gent-code",
		yes: opts.yes,
	});
	for (const l of describe("8gent", code)) log(l);
	if (["failed", "refused", "declined"].includes(code.status)) bad = true;
	if (code.status === "updated") report?.({ updated: true, to: short(code.to ?? "") });

	const found = findBrowserCheckout({
		env,
		home: deps.home ?? homedir(),
		platform,
		codeRoot: root,
		hasGit: deps.hasGit,
	});
	if (found.note) log(found.note);
	if (!found.dir) {
		log(
			`8gent Browser: no source checkout found (looked in ${found.looked.join(", ") || "nowhere"}); skipped.`,
		);
	} else {
		const br = await updateCheckout(d, {
			dir: found.dir,
			force: opts.force,
			checkOnly: opts.checkOnly,
			build: true,
			repo: "8gent-browser",
			yes: opts.yes,
		});
		for (const l of describe(`8gent Browser (${found.dir})`, br)) log(l);
		if (["failed", "refused", "declined"].includes(br.status)) bad = true;
	}
	return bad ? 1 : 0;
}
