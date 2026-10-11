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
 *
 * The same set is applied under EIGHT_DATA_DIR when that is set, and each path
 * is also denied by its realpath. Reads stay allowed. Everything else the
 * command does (the workspace, the network, other ~/.8gent files) is
 * unchanged: the profile is allow-default with targeted write denies.
 *
 *   macOS   Seatbelt (sandbox-exec). Default on. EIGHT_SEATBELT=0 turns it off.
 *   Linux   bubblewrap read-only binds when bwrap is installed and works;
 *           paths that do not exist yet cannot be bound (see the PR / docs).
 *   Windows no OS boundary; the text backstops are all that stand.
 *
 * Not applied when the host already sandboxes this process (sandbox-exec
 * cannot nest). runCommandSandboxStatus() says which case applies.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
] as const;

/** Directories whose whole tree is protected, relative to a data dir. */
export const PROTECTED_DATA_DIRS = [
	"extensions",
	"prompts",
	"packages",
	"browser-profiles",
	"audit",
	"sessions",
	"logs",
	"checkpoints",
] as const;

function homeDir(): string {
	// Same test hook as path-guard and seatbelt.ts.
	return process.env.EIGHT_FAKE_HOME || os.homedir();
}

/** ~/.8gent, plus EIGHT_DATA_DIR when it points elsewhere. */
export function protectedDataRoots(): string[] {
	const roots = [path.join(homeDir(), ".8gent")];
	const dataDir = process.env.EIGHT_DATA_DIR;
	if (dataDir && path.isAbsolute(dataDir)) roots.push(dataDir);
	return [...new Set(roots.map((r) => path.normalize(r)))];
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
		return [`(literal ${sbplString(d)})`, `(subpath ${sbplString(d)})`, ...(re ? [`(regex ${re})`] : [])];
	});
	const rootFilters = p.roots.flatMap((r) => {
		const re = caseInsensitivePathRegex(r, false);
		return [`(literal ${sbplString(r)})`, ...(re ? [`(regex ${re})`] : [])];
	});
	return `${[
		"(version 1)",
		"(allow default)",
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
 * be bound, so it is not covered (documented gap).
 */
export function buildBwrapArgs(p: ProtectedPaths = protectedRunCommandPaths()): string[] {
	const args = ["--dev-bind", "/", "/"];
	for (const target of [...p.files, ...p.dirs]) {
		if (fs.existsSync(target)) args.push("--ro-bind", target, target);
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
	| { applied: false; reason: string };

/** Which OS boundary run_command gets on this host, and why not when none. */
export function runCommandSandboxStatus(): RunCommandSandbox {
	if (process.env.EIGHT_SEATBELT === "0") return { applied: false, reason: "EIGHT_SEATBELT=0" };
	if (process.platform === "darwin") {
		if (!fs.existsSync(SANDBOX_EXEC)) return { applied: false, reason: "sandbox-exec missing" };
		if (!canApplySeatbelt())
			return { applied: false, reason: "host already sandboxes this process (sandbox-exec cannot nest)" };
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

/**
 * Wrap a run_command so the kernel refuses writes to the protected set,
 * whatever the command text says. Returned unchanged when no OS boundary can
 * be applied (see runCommandSandboxStatus).
 */
export function wrapRunCommand(command: string): string {
	const status = runCommandSandboxStatus();
	if (!status.applied) return command;
	if (status.mechanism === "seatbelt") {
		return `${SANDBOX_EXEC} -p ${shellQuote(buildRunCommandProfile())} /bin/sh -c ${shellQuote(command)}`;
	}
	const bwrap = findBwrap() as string;
	return [bwrap, ...buildBwrapArgs(), "/bin/sh", "-c", command].map(shellQuote).join(" ");
}
