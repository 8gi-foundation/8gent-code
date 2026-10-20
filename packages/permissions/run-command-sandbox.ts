/**
 * 8gent Code - OS sandbox for run_command (#4009, #3612)
 *
 * Text checks on a shell command can always be bypassed: a command can build
 * a path at run time, decode it, or hand it to another interpreter. The
 * boundary that holds is the kernel. Every run_command child (native and text
 * tool paths) is wrapped so it cannot create, change, replace, rename, link or
 * remove the files 8gent loads and runs at start, its secrets, or its records:
 *
 *   ~/.8gent/{hooks.yaml,hooks.json,settings.json,browser-control.token}
 *   ~/.8gent/{extensions,prompts,packages,browser-profiles}/
 *   ~/.8gent/{audit/,audit.jsonl,permissions-audit.jsonl}
 *   ~/.8gent/{sessions,logs,checkpoints}/, daemon.log, approvals-audit.jsonl
 *   ~/.8gent/{policies.yaml,policy-checksum,mcp.json,.env,keys.env,bin/}
 *   ~/.8gent/skills-trust.json (which project skills may replace user/bundled ones)
 *   ~/.8gent/keys/ (state-hmac.key, the /goal state and approval grant signing key)
 *
 * The same set is applied under EIGHT_HOME/.8gent and EIGHT_DATA_DIR when
 * those are set, and each path
 * is also denied by its realpath. Reads stay allowed. Everything else the
 * command does (the workspace, the network, other ~/.8gent files) is
 * unchanged: the profile is allow-default with targeted write denies.
 *
 *   macOS   Seatbelt (sandbox-exec). Default on. EIGHT_SEATBELT=0 turns it
 *           off; EIGHT_SEATBELT=require refuses to run a command unwrapped.
 *   Linux   bubblewrap read-only binds when bwrap is installed and works;
 *           paths that do not exist yet cannot be bound (see the PR / docs).
 *   Windows no OS boundary; the text backstops are all that stand.
 *
 * Not applied when the host already sandboxes this process (sandbox-exec
 * cannot nest). runCommandSandboxStatus() says which case applies, and an
 * unwrapped run is never silent: one stderr warning per process, an audit
 * line, and onRunCommandUnsandboxed() listeners (the TUI status hook point).
 *
 * The env keys that steer this (EIGHT_SEATBELT, EIGHT_DATA_DIR, EIGHT_HOME,
 * HOME) are snapshotted when this module loads, before the TUI's own .env
 * loader runs. A key that any .env file 8gent or Bun would load declares is
 * ignored, whatever its value: Bun's dotenv parser (comments, quotes, $VAR and
 * ${VAR} expansion, backticks) differs from any we could write, so comparing
 * values is bypassable. A command that writes `EIGHT_SEATBELT=0` into ./.env
 * must not turn the boundary off for the next launch. The cost: a user who
 * both exports a key and declares it in such a .env loses the export for this
 * boundary. EIGHT_SEATBELT=require, the stricter setting, is always kept. EIGHT_FAKE_HOME is a test hook and is
 * honoured only under NODE_ENV=test or BUN_ENV=test (themselves not from .env).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { loadOrCreateKey } from "./goal-state-hmac";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Files 8gent runs, trusts or records, relative to a data dir. */
export const PROTECTED_DATA_FILES = [
	"hooks.yaml",
	"hooks.json",
	"settings.json",
	"browser-control.token",
	"audit.jsonl",
	"permissions-audit.jsonl",
	"daemon.log",
	"approvals-audit.jsonl",
	"policies.yaml",
	"mcp.json",
	".env",
	"keys.env",
	"allow-loopback.json", // the browser's trusted loopback port list (#3785, 8SO)
	"keybindings.json",
	"update-resume.json",
	"skills-trust.json", // sha256 pins that let a project skill replace a user/bundled one (#4125, 8SO)
] as const;

/**
 * Protected dirs that run_command may not even read (#4132, 8SO): keys/state-hmac.key
 * signs /goal state, approval grants and the Table ledger, so reading it is forging them.
 */
// secrets/ holds the default Telegram bot key file (/telegram setup, #4594): no read, no write.
export const READ_DENIED_DATA_DIRS = ["keys", "secrets"] as const;

function isReadDenied(dir: string): boolean {
	return (READ_DENIED_DATA_DIRS as readonly string[]).includes(path.basename(dir));
}

/** Directories whose whole tree is protected, relative to a data dir. */
export const PROTECTED_DATA_DIRS = [
	"extensions",
	"themes",
	"prompts",
	"packages",
	"browser-profiles",
	"audit",
	"sessions",
	"logs",
	"checkpoints",
	"bin",
	// keys/state-hmac.key signs /goal state and approval grants (#4132, 8SO). The whole dir,
	// not just the file: a file rule alone lets the dir be renamed aside and a forged one moved in.
	"keys",
	// The default Telegram bot key file lives here (#4594); read-denied too.
	"secrets",
	// A file or a directory: a subpath rule covers both.
	"policy-checksum",
] as const;

// ============================================
// Security env snapshot
// ============================================

/** Env keys that decide whether and where the boundary applies. */
export const SECURITY_ENV_KEYS = [
	"EIGHT_SEATBELT",
	"EIGHT_DATA_DIR",
	"EIGHT_HOME",
	"EIGHT_FAKE_HOME",
	"HOME",
	"USERPROFILE",
	"NODE_ENV",
	"BUN_ENV",
	// Where post_message and /telegram setup send the bot key (#4594): a .env must not move it.
	"EIGHT_TG_API_BASE",
] as const;
type SecurityKey = (typeof SECURITY_ENV_KEYS)[number];

export interface SecurityEnv {
	values: Partial<Record<SecurityKey, string>>;
	/** Keys declared in a .env file, so ignored. */
	ignored: SecurityKey[];
}

/** The .env files Bun (cwd, by NODE_ENV) or the TUI loader could have read. */
export function dotenvCandidates(
	cwd: string = process.cwd(),
	home: string = os.homedir(),
): string[] {
	const names = [".env", ".env.local"];
	for (const mode of ["development", "production", "test"])
		names.push(`.env.${mode}`, `.env.${mode}.local`);
	return [
		...names.map((n) => path.join(cwd, n)),
		path.resolve(import.meta.dirname, "../../.env"),
		path.join(home, ".8gent", ".env"),
		// The keys file is shell-style too: an EIGHT_DATA_DIR in it is not trusted env (#4132, 8SO).
		path.join(home, ".8gent", "keys.env"),
	];
}

/** Keys declared (KEY=..., export KEY=..., any value form) in the given dotenv files. */
export function dotenvDeclaredKeys(files: string[]): Set<string> {
	const keys = new Set<string>();
	for (const f of files) {
		let text: string;
		try {
			// A leading BOM would hide the first key from the match; Bun still loads it.
			text = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[=:]/gm))
			keys.add(m[1] as string);
	}
	return keys;
}

/**
 * Pure: drop each security key any .env file declares, whatever the value.
 * EIGHT_SEATBELT=require is kept regardless: dropping it could only weaken.
 */
export function snapshotSecurityEnv(
	env: Readonly<Partial<Record<SecurityKey, string>>>,
	declared: Set<string>,
): SecurityEnv {
	const values: SecurityEnv["values"] = {};
	const ignored: SecurityKey[] = [];
	for (const k of SECURITY_ENV_KEYS) {
		const v = env[k];
		if (v === undefined || v === "") continue;
		if (declared.has(k) && !(k === "EIGHT_SEATBELT" && v === "require")) ignored.push(k);
		else values[k] = v;
	}
	return { values, ignored };
}

function takeSnapshot(): SecurityEnv {
	return snapshotSecurityEnv(process.env, dotenvDeclaredKeys(dotenvCandidates()));
}

// Taken at module load: before the TUI's loadEnvFile() runs (app.tsx imports
// this module's importers first), so nothing it sets can steer the boundary.
let securityEnv: SecurityEnv = takeSnapshot();

export function securityEnvSnapshot(): SecurityEnv {
	return securityEnv;
}

/** Pure: test mode comes only from a NODE_ENV/BUN_ENV that a .env file did not set. */
export function isTestMode(values: SecurityEnv["values"]): boolean {
	return values.NODE_ENV === "test" || values.BUN_ENV === "test";
}

function inTestMode(): boolean {
	return isTestMode(securityEnv.values);
}

/** Tests only: re-read the env after changing it. A no-op outside test mode. */
export function refreshSecurityEnvForTests(): void {
	if (inTestMode()) securityEnv = takeSnapshot();
}

/** EIGHT_FAKE_HOME is a test hook: honoured only in test mode, read live there. */
function fakeHome(): string | undefined {
	return inTestMode() ? process.env.EIGHT_FAKE_HOME || undefined : undefined;
}

/** ~/.8gent, resolveHome()/.8gent (EIGHT_HOME), and EIGHT_DATA_DIR, deduplicated. */
export function protectedDataRoots(): string[] {
	const v = securityEnv.values;
	const fake = fakeHome();
	const home = fake ?? os.homedir();
	const roots = [
		path.join(home, ".8gent"),
		path.join(
			resolveHome({ EIGHT_HOME: v.EIGHT_HOME, HOME: fake ?? v.HOME, USERPROFILE: v.USERPROFILE }),
			".8gent",
		),
	];
	// Path keys only ever ADD roots: a value from .env (ignored for trust) or set
	// after the snapshot may still be where the harness reads from, so it is
	// protected too. Nothing here can remove a root.
	for (const dataDir of [v.EIGHT_DATA_DIR, process.env.EIGHT_DATA_DIR]) {
		if (dataDir && path.isAbsolute(dataDir)) roots.push(dataDir);
	}
	const liveEightHome = process.env.EIGHT_HOME;
	if (liveEightHome && path.isAbsolute(liveEightHome))
		roots.push(path.join(liveEightHome, ".8gent"));
	return [...new Set(roots.filter((r) => path.isAbsolute(r)).map((r) => path.normalize(r)))];
}

export interface ProtectedPaths {
	/** The data roots themselves: may not be renamed, removed or replaced. */
	roots: string[];
	/** Single files. */
	files: string[];
	/** Whole trees. */
	dirs: string[];
}

/**
 * Resolve a path that may not exist yet: realpath the deepest existing
 * ancestor and append the rest. The kernel matches real paths, so a symlinked
 * HOME or ~/.8gent is only covered when its real spelling is denied too.
 */
export function realpathLoose(p: string): string {
	const abs = path.resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			const real = fs.realpathSync(cur);
			return tail.length ? path.join(real, ...tail.reverse()) : real;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return abs;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

function withReal(paths: string[]): string[] {
	return [...new Set(paths.flatMap((p) => [path.normalize(p), realpathLoose(p)]))];
}

/** Every protected path, spelled as given and by realpath. */
export function protectedRunCommandPaths(): ProtectedPaths {
	const roots = protectedDataRoots();
	return {
		roots: withReal(roots),
		files: withReal(roots.flatMap((r) => PROTECTED_DATA_FILES.map((f) => path.join(r, f)))),
		dirs: withReal(roots.flatMap((r) => PROTECTED_DATA_DIRS.map((d) => path.join(r, d)))),
	};
}

// ============================================
// macOS Seatbelt profile (pure)
// ============================================

function sbplString(p: string): string {
	return `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * A case-insensitive SBPL regex for a path. APFS is case-insensitive by
 * default, so ~/.8gent/HOOKS.YAML is the same file the loader opens; a literal
 * rule alone would let a new file be created under another case. Returns
 * undefined for a path SBPL's #"..." form cannot carry (a double quote).
 */
export function caseInsensitivePathRegex(p: string, subtree: boolean): string | undefined {
	if (p.includes('"')) return undefined;
	let body = "";
	for (const ch of p) {
		const lo = ch.toLowerCase();
		const up = ch.toUpperCase();
		if (lo !== up && lo.length === 1 && up.length === 1) body += `[${lo}${up}]`;
		else if (/[.^$|?*+()[\]{}\\]/.test(ch)) body += `\\${ch}`;
		else body += ch;
	}
	return `#"^${body}${subtree ? "(/.*)?" : ""}$"`;
}

/**
 * Allow-default profile denying every write-class operation on the protected
 * set. SBPL: the last matching rule wins, so the denies follow (allow default).
 *
 * - files and trees: file-write* (create, data, unlink, rename, mode, owner,
 *   xattr, times) and file-link (no hard link out of or into them).
 * - data roots: file-write* on the directory itself, so it cannot be moved
 *   aside, removed, or created anew and filled.
 */
export function buildRunCommandProfile(p: ProtectedPaths = protectedRunCommandPaths()): string {
	const fileFilters = p.files.flatMap((f) => {
		const re = caseInsensitivePathRegex(f, false);
		return [`(literal ${sbplString(f)})`, ...(re ? [`(regex ${re})`] : [])];
	});
	const dirFilters = p.dirs.flatMap((d) => {
		const re = caseInsensitivePathRegex(d, true);
		return [
			`(literal ${sbplString(d)})`,
			`(subpath ${sbplString(d)})`,
			...(re ? [`(regex ${re})`] : []),
		];
	});
	const rootFilters = p.roots.flatMap((r) => {
		const re = caseInsensitivePathRegex(r, false);
		return [`(literal ${sbplString(r)})`, ...(re ? [`(regex ${re})`] : [])];
	});
	const readDenyFilters = p.dirs.filter(isReadDenied).flatMap((d) => {
		const re = caseInsensitivePathRegex(d, true);
		return [
			`(literal ${sbplString(d)})`,
			`(subpath ${sbplString(d)})`,
			...(re ? [`(regex ${re})`] : []),
		];
	});
	return `${[
		"(version 1)",
		"(allow default)",
		...(readDenyFilters.length
			? [
					"; signing keys: no reads either (#4132)",
					`(deny file-read* ${readDenyFilters.join(" ")})`,
				]
			: []),
		"; 8gent startup code, secrets and records: no writes from run_command (#4009, #3612)",
		`(deny file-write* file-link ${[...fileFilters, ...dirFilters].join(" ")})`,
		"; the data roots themselves: no rename, remove or re-create",
		`(deny file-write* ${rootFilters.join(" ")})`,
	].join("\n")}\n`;
}

// ============================================
// Linux bubblewrap (pure argv)
// ============================================

/**
 * bwrap argv that keeps the whole filesystem as it is and re-mounts each
 * protected path that exists read-only. A path that does not exist yet cannot
 * be bound, so it is not covered (documented gap), except the read-denied
 * dirs (keys/): those are created (0700) first so they are always bound, and
 * then covered by an empty tmpfs so the command cannot read the key (#4132).
 */
export function buildBwrapArgs(p: ProtectedPaths = protectedRunCommandPaths()): string[] {
	for (const d of p.dirs.filter(isReadDenied)) {
		try {
			fs.mkdirSync(d, { recursive: true, mode: 0o700 });
		} catch {}
	}
	const args = ["--dev-bind", "/", "/"];
	for (const target of [...p.files, ...p.dirs]) {
		if (fs.existsSync(target)) args.push("--ro-bind", target, target);
	}
	for (const d of p.dirs.filter(isReadDenied)) {
		if (fs.existsSync(d)) args.push("--tmpfs", d);
	}
	return args;
}

// ============================================
// Wrapping
// ============================================

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

const probeCache = new Map<string, boolean>();
function probe(file: string, args: string[]): boolean {
	const key = [file, ...args].join("\0");
	let ok = probeCache.get(key);
	if (ok === undefined) {
		try {
			ok = spawnSync(file, args, { stdio: "ignore", timeout: 5000 }).status === 0;
		} catch {
			ok = false;
		}
		probeCache.set(key, ok);
	}
	return ok;
}

/** True when sandbox-exec can apply a profile here (false inside another sandbox). */
export function canApplySeatbelt(): boolean {
	return (
		process.platform === "darwin" &&
		fs.existsSync(SANDBOX_EXEC) &&
		probe(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"])
	);
}

function findBwrap(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "bwrap");
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export type RunCommandSandbox =
	| { applied: true; mechanism: "seatbelt" | "bwrap" }
	| { applied: false; reason: string; required: boolean };

/** Which OS boundary run_command gets on this host, and why not when none. */
export function runCommandSandboxStatus(): RunCommandSandbox {
	const status = sandboxStatusInner();
	if (status.applied) return status;
	return { ...status, required: securityEnv.values.EIGHT_SEATBELT === "require" };
}

function sandboxStatusInner(): RunCommandSandbox | { applied: false; reason: string } {
	if (securityEnv.values.EIGHT_SEATBELT === "0")
		return { applied: false, reason: "EIGHT_SEATBELT=0" };
	if (process.platform === "darwin") {
		if (!fs.existsSync(SANDBOX_EXEC)) return { applied: false, reason: "sandbox-exec missing" };
		if (!canApplySeatbelt())
			return {
				applied: false,
				reason: "host already sandboxes this process (sandbox-exec cannot nest)",
			};
		return { applied: true, mechanism: "seatbelt" };
	}
	if (process.platform === "linux") {
		const bwrap = findBwrap();
		if (!bwrap) return { applied: false, reason: "bwrap not installed" };
		if (!probe(bwrap, ["--dev-bind", "/", "/", "/bin/true"]))
			return { applied: false, reason: "bwrap cannot create a namespace here" };
		return { applied: true, mechanism: "bwrap" };
	}
	return { applied: false, reason: `no OS sandbox on ${process.platform}` };
}

// ============================================
// Unwrapped runs are never silent
// ============================================

type UnsandboxedListener = (status: Extract<RunCommandSandbox, { applied: false }>) => void;
const listeners = new Set<UnsandboxedListener>();
let warned = false;

/** Hook point for the TUI status line: called on every unwrapped run. Returns an unsubscribe. */
export function onRunCommandUnsandboxed(listener: UnsandboxedListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function auditPath(): string {
	const roots = protectedDataRoots();
	const root =
		securityEnv.values.EIGHT_DATA_DIR && path.isAbsolute(securityEnv.values.EIGHT_DATA_DIR)
			? securityEnv.values.EIGHT_DATA_DIR
			: (roots[0] as string);
	return path.join(root, "audit", "run-command-sandbox.jsonl");
}

function reportUnsandboxed(
	status: Extract<RunCommandSandbox, { applied: false }>,
	command: string,
): void {
	if (!warned) {
		warned = true;
		const ignored = securityEnv.ignored.length
			? ` (ignored from .env: ${securityEnv.ignored.join(", ")})`
			: "";
		process.stderr.write(
			`[8gent] WARNING: run_command is NOT OS-sandboxed: ${status.reason}${ignored}. ` +
				"Writes to ~/.8gent startup code, secrets and records are stopped by text checks only. " +
				"Set EIGHT_SEATBELT=require to refuse unsandboxed commands.\n",
		);
	}
	try {
		const file = auditPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(
			file,
			`${JSON.stringify({ ts: new Date().toISOString(), event: "run_command_unsandboxed", reason: status.reason, required: status.required, command: command.slice(0, 200) })}\n`,
		);
	} catch {}
	for (const l of listeners) {
		try {
			l(status);
		} catch {}
	}
}

/** Short form of a status reason for the TUI footer: the part before any "(...)". */
export function sandboxFooterReason(reason: string): string {
	// A footer word, not a sentence: the hint caps share the row (footer-clicks test).
	const CODES: [RegExp, string][] = [
		[/^EIGHT_SEATBELT=0/, "turned off"],
		[/sandbox-exec missing/, "no sandbox-exec"],
		[/already sandboxes/, "nested"],
		[/bwrap not installed/, "no bwrap"],
		[/bwrap cannot/, "no namespaces"],
		[/^no OS sandbox on /, "unsupported OS"],
	];
	for (const [re, code] of CODES) if (re.test(reason)) return code;
	const short = reason.split(" (")[0]?.trim() || reason;
	return short.length > 16 ? `${short.slice(0, 15)}…` : short;
}

/**
 * Callers check this before spawning: a refusal message when
 * EIGHT_SEATBELT=require and no OS boundary can be applied, else undefined.
 */
export function runCommandSandboxRefusal(): string | undefined {
	const status = runCommandSandboxStatus();
	if (status.applied || !status.required) return undefined;
	return `[PERMISSION DENIED] EIGHT_SEATBELT=require and run_command cannot be OS-sandboxed here: ${status.reason}`;
}

export class RunCommandSandboxRequired extends Error {}

let signingKeyEnsured = false;

/**
 * Create <data dir>/keys (0700) and state-hmac.key before the first command is
 * wrapped, so no command runs while the key is still absent and plantable
 * (#4132, 8SO). Once per process. A failure (for example a key path refused
 * as in-project) never blocks the command: signing reports it on use.
 */
function ensureSigningKey(): void {
	if (signingKeyEnsured) return;
	signingKeyEnsured = true;
	try {
		loadOrCreateKey();
	} catch {}
}

/**
 * Wrap a run_command so the kernel refuses writes to the protected set,
 * whatever the command text says. When no OS boundary can be applied the
 * command is returned unchanged and reported (stderr once, audit line,
 * listeners), or, under EIGHT_SEATBELT=require, refused with a throw.
 */
export function wrapRunCommand(command: string): string {
	ensureSigningKey();
	const status = runCommandSandboxStatus();
	if (!status.applied) {
		if (status.required) throw new RunCommandSandboxRequired(runCommandSandboxRefusal());
		reportUnsandboxed(status, command);
		return command;
	}
	if (status.mechanism === "seatbelt") {
		return `${SANDBOX_EXEC} -p ${shellQuote(buildRunCommandProfile())} /bin/sh -c ${shellQuote(command)}`;
	}
	const bwrap = findBwrap() as string;
	return [bwrap, ...buildBwrapArgs(), "/bin/sh", "-c", command].map(shellQuote).join(" ");
}

/**
 * The argv form of wrapRunCommand, for tools that spawn a binary with an args
 * array and no shell (the native git and gh tools, #3998). Returns the full argv
 * to spawn: sandbox-exec -p <profile> or bwrap <binds> in front of `bin args`,
 * never a shell. Git runs repository config (fsmonitor, hooks, aliases,
 * sshCommand), so the same kernel boundary applies. Same rules as
 * wrapRunCommand when no boundary applies: report, or throw under require.
 */
export function wrapRunCommandArgv(bin: string, args: readonly string[]): string[] {
	ensureSigningKey();
	const status = runCommandSandboxStatus();
	if (!status.applied) {
		if (status.required) throw new RunCommandSandboxRequired(runCommandSandboxRefusal());
		reportUnsandboxed(status, [bin, ...args].join(" "));
		return [bin, ...args];
	}
	if (status.mechanism === "seatbelt")
		return [SANDBOX_EXEC, "-p", buildRunCommandProfile(), bin, ...args];
	return [findBwrap() as string, ...buildBwrapArgs(), bin, ...args];
}
