/**
 * 8gent Code - the workspace read boundary in the Linux kernel (#4890 slice 2)
 *
 * macOS gets the read rule from Seatbelt (osReadRules in run-command-sandbox.ts). Linux and
 * Termux get it from Landlock, when the kernel has it (ABI v1 or later). Behind the same flag,
 * EIGHT_OS_READ_BOUNDARY=1, default off.
 *
 * Landlock rules restrict the process that adds them and everything it starts, so the rule has
 * to be applied in the child, between fork and exec. Neither Bun nor Node gives a hook there,
 * and Termux runs the Node build (no bun:ffi). The helper is a short Python program run with
 * `python3 -I -S -c`: ctypes calls the three Landlock syscalls, then execv's the shell. Nothing
 * is installed or shipped as a file. No python3, or a kernel without Landlock: the command runs
 * as it does today and one plain line says the OS rule is not active. A helper that fails after
 * it started never runs the command unrestricted: it exits 126 with a message.
 *
 * Landlock only allows. There is no deny that wins over an allow, so a folder that holds a
 * never-read path (a home with .ssh in it, ~/.8gent with memory.db in it) is never granted
 * whole: its entries are granted one by one, minus the never-read ones, and a folder that holds
 * one of those is opened the same way. For a session rooted at the home folder this means:
 *   - every file and folder in the home is readable except the credential stores and the
 *     private data set, as on macOS;
 *   - the home folder itself (and ~/.config, ~/.local/share, ~/.8gent) cannot be listed:
 *     `ls ~` fails, `ls ~/project` works. A listing right on the folder would reach the
 *     names inside ~/.ssh too, because a Landlock grant always covers the whole tree;
 *   - a file a command creates at the top of the home cannot be read back by the same command
 *     (the next command sees it: the list is built again for each command);
 *   - files at the top of the home cannot be removed or renamed (git config --global writes
 *     ~/.gitconfig by a rename, so it fails), because the rename right on that folder would
 *     also let .ssh be renamed to a readable name.
 *
 * Rename and link: the rule also handles REMOVE_FILE and REMOVE_DIR (granted everywhere except
 * on the folders that hold a never-read path) and, from ABI v2, REFER. A file cannot be renamed
 * or unlinked out of the never-read set, and Landlock refuses to move a file into a folder where
 * it would gain read access, so `mv ~/.ssh/id_rsa ./k` fails (mv then copies, and the copy cannot
 * read the key) and so does moving any unreadable outside file into the root (#4894 item 3).
 * A hard link counts as a move. On ABI v1 every move across folders is refused.
 *
 * Not covered: stat. Landlock has no metadata right, so the size and dates of a never-read
 * file can still be seen. That is enough for nothing on Linux: hard links need REFER, and
 * reflink and copy_file_range need a file opened for reading.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What any program needs to start on Linux and Termux: the OS, libraries, config, /proc, /sys,
 * /dev, and on Android the system partitions and Termux's prefix. Missing ones are skipped.
 * /run is not here (it can hold container secrets); only the resolver folders under it are.
 */
export const LINUX_READ_SYSTEM_DIRS = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/etc",
	"/opt",
	"/proc",
	"/sys",
	"/dev",
	"/snap",
	"/nix/store",
	"/run/systemd/resolve",
	"/run/resolvconf",
	// Android / Termux
	"/system",
	"/apex",
	"/vendor",
	"/product",
	"/system_ext",
	"/odm",
	"/linkerconfig",
	"/data/data/com.termux/files/usr",
] as const;

/** Linux spellings of the browser and mail stores HOME_NEVER_READ names in their macOS form. */
export const LINUX_HOME_NEVER_READ = [
	".mozilla",
	".thunderbird",
	".config/google-chrome",
	".config/chromium",
	".config/BraveSoftware",
	".config/microsoft-edge",
	".config/1Password",
	".local/share/keyrings",
] as const;

/** Under a data root, the first name that holds the private set (read-boundary.ts OWN_PRIVATE). */
const OWN_PRIVATE_TOP =
	/^(memory[^/]*|brain[^/]*|clients|browser-[^/]*|audit[^/]*|backups|app-backups|cron[^/]*)$/i;
/** Under a data root, credential-shaped first names (read-allow.ts SECRET_PATH). */
const OWN_SECRET_TOP =
	/^(keys|secrets|telegram[^/]*|sessions|[^/]*token[^/]*|\.env[^/]*|[^/]*\.env|credentials[^/]*)$/i;
/** Anywhere under a data root: databases and key files. */
const OWN_PRIVATE_EXT = /\.(db|sqlite3?|db-wal|db-shm|pem|key|p12)$/i;

/** True when `p` (a real path) is in the private set of one of the data roots. */
export function inPrivateDataSet(p: string, dataRoots: readonly string[]): boolean {
	for (const r of dataRoots) {
		if (!p.startsWith(`${r}/`)) continue;
		const rel = p.slice(r.length + 1);
		const top = rel.split("/")[0] ?? "";
		if (OWN_PRIVATE_TOP.test(top) || OWN_SECRET_TOP.test(top)) return true;
		if (OWN_PRIVATE_EXT.test(path.basename(rel))) return true;
	}
	return false;
}

const under = (p: string, dir: string) => (dir === "/" ? p !== "/" : p.startsWith(`${dir}/`));

/** Resolve a path through its deepest existing ancestor (the kernel sees real paths). */
function real(p: string): string {
	const abs = path.resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			const r = fs.realpathSync(cur);
			return tail.length ? path.join(r, ...tail.reverse()) : r;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return abs;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

const bothSpellings = (ps: readonly string[]) => [
	...new Set(ps.filter((p) => path.isAbsolute(p)).flatMap((p) => [path.normalize(p), real(p)])),
];

/**
 * The walk inside the data roots (to find databases and key files at any depth) visits at most
 * this many entries per command. A folder it cannot finish is left shut: not readable, not
 * removable. A real ~/.8gent can hold over a million entries, so its big folders are shut under
 * the Linux rule; the small ones (skills, bin, config) open.
 */
export const WALK_BUDGET = 2000;

export interface LandlockPlan {
	/** Granted read (files: read; folders: read, list, and move within readable folders). */
	read: string[];
	/** Granted remove and rename of entries (folders only). */
	remove: string[];
}

/**
 * The grant lists for one command. Pure apart from reading folder listings.
 *
 * `never`: real paths never readable, removable or renamable (credential stores, keys/).
 * `dataRoots`: their private set (OWN_PRIVATE and friends) is never readable either, at any depth.
 */
export function landlockPlan(
	readStarts: readonly string[],
	never: readonly string[],
	dataRoots: readonly string[],
	budget = WALK_BUDGET,
): LandlockPlan {
	const neverSet = bothSpellings(never);
	const roots = bothSpellings(dataRoots);
	let left = budget;
	const listing = new Map<string, fs.Dirent[] | null>();
	/** Sorted, so a budget cut always falls in the same place. null: unreadable. */
	const read = (dir: string): fs.Dirent[] | null => {
		let entries = listing.get(dir);
		if (entries === undefined) {
			try {
				entries = fs
					.readdirSync(dir, { withFileTypes: true })
					.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			} catch {
				entries = null;
			}
			listing.set(dir, entries);
		}
		return entries;
	};
	// Only the walk inside data roots spends the budget: the folders above a never-read path
	// (/, the home, ~/.config) are listed whatever it costs, so a big ~/.8gent cannot shut them.
	const walked = new Set<string>();
	const walk = (dir: string): fs.Dirent[] | undefined => {
		const entries = read(dir);
		if (!entries) return undefined;
		if (!walked.has(dir)) {
			walked.add(dir);
			left -= entries.length;
		}
		return left < 0 ? undefined : entries;
	};
	const isNever = (p: string) =>
		neverSet.some((n) => p === n || under(p, n)) || inPrivateDataSet(p, roots);
	// Inside a data root the private set is a pattern, so a folder is clean only once walked.
	const dirtyMemo = new Map<string, boolean | "unknown">();
	const dirty = (dir: string): boolean | "unknown" => {
		const memo = dirtyMemo.get(dir);
		if (memo !== undefined) return memo;
		const entries = walk(dir);
		let result: boolean | "unknown" = false;
		if (!entries) result = "unknown";
		else
			for (const e of entries) {
				const p = path.join(dir, e.name);
				if (isNever(p) || neverSet.some((n) => under(n, p))) {
					result = true;
					break;
				}
				if (e.isDirectory()) {
					const d = dirty(p);
					if (d !== false) {
						result = d;
						if (d === true) break;
					}
				}
			}
		dirtyMemo.set(dir, result);
		return result;
	};
	/** "open": grant whole. "split": grant entry by entry. "shut": grant nothing. */
	const how = (dir: string): "open" | "split" | "shut" => {
		if (neverSet.some((n) => under(n, dir))) return "split";
		if (roots.some((r) => r === dir || under(r, dir))) return "split";
		if (roots.some((r) => under(dir, r))) {
			const d = dirty(dir);
			return d === false ? "open" : d === true ? "split" : "shut";
		}
		return "open";
	};
	const expand = (starts: readonly string[], out: Set<string>, filesToo: boolean) => {
		const visit = (p: string, top: boolean) => {
			if (isNever(p)) return;
			let st: fs.Stats;
			try {
				st = top ? fs.statSync(p) : fs.lstatSync(p);
			} catch {
				return;
			}
			// A link inside a split folder is never granted: the kernel would grant its target.
			if (st.isSymbolicLink()) return;
			if (!st.isDirectory()) {
				if (filesToo) out.add(p);
				return;
			}
			const mode = how(p);
			if (mode === "open") out.add(p);
			else if (mode === "split") {
				const entries = read(p);
				if (!entries) return;
				for (const e of entries) visit(path.join(p, e.name), false);
			}
		};
		for (const s of starts) visit(s, true);
	};
	const readGrants = new Set<string>();
	expand(bothSpellings(readStarts).map(real), readGrants, true);
	const removeGrants = new Set<string>();
	expand(["/"], removeGrants, false);
	return { read: [...readGrants], remove: [...removeGrants] };
}

// ============================================
// The helper (Python, run with -I -S -c)
// ============================================

/**
 * argv after the source: `probe`, or `R <paths...> W <paths...> -- <program> <args...>`.
 * Syscall numbers 444-446 are the same on every architecture (added together in Linux 5.13).
 * Exit 126 with a message on any failure after start: never exec without the rule.
 */
export const LANDLOCK_HELPER = `import ctypes as C, os, stat, sys
def die(m):
    sys.stderr.write("8gent: the OS read rule could not be applied, so the command did not run: %s\\n" % m)
    sys.stderr.flush()
    os._exit(126)
L = C.CDLL(None, use_errno=True)
L.syscall.restype = C.c_long
def sc(*a):
    r = L.syscall(*[C.c_long(x) if isinstance(x, int) else x for x in a])
    if r < 0:
        e = C.get_errno()
        raise OSError(e, os.strerror(e))
    return r
class RA(C.Structure):
    _fields_ = [("fs", C.c_uint64)]
class PB(C.Structure):
    _pack_ = 1
    _fields_ = [("access", C.c_uint64), ("fd", C.c_int32)]
RF, RD, RMD, RMF, REF = 4, 8, 16, 32, 1 << 13
OP = getattr(os, "O_PATH", 0o10000000)
def abi():
    try:
        return sc(444, C.c_void_p(0), 0, 1)
    except OSError:
        return 0
def apply(reads, removes):
    v = abi()
    if v < 1:
        die("Landlock is not available on this kernel")
    ref = REF if v >= 2 else 0
    try:
        rs = sc(444, C.byref(RA(RF | RD | RMF | RMD | ref)), 8, 0)
    except OSError as e:
        die("landlock_create_ruleset: %s" % e)
    def add(p, dmask, fmask):
        try:
            fd = os.open(p, OP | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            return
        try:
            m = os.fstat(fd).st_mode
            if stat.S_ISLNK(m):
                return
            acc = dmask if stat.S_ISDIR(m) else fmask
            if acc:
                sc(445, rs, 1, C.byref(PB(acc, fd)), 0)
        except OSError as e:
            die("landlock_add_rule %s: %s" % (p, e))
        finally:
            os.close(fd)
    for p in reads:
        add(p, RF | RD | ref, RF)
    for p in removes:
        add(p, RMF | RMD | ref, 0)
    if L.prctl(38, 1, 0, 0, 0) != 0:
        die("prctl(PR_SET_NO_NEW_PRIVS)")
    try:
        sc(446, rs, 0)
    except OSError as e:
        die("landlock_restrict_self: %s" % e)
    os.close(rs)
    return v
a = sys.argv[1:]
if a[:1] == ["probe"]:
    if abi() < 1:
        sys.exit(3)
    print(apply(["/"], []))
    sys.exit(0)
reads, removes, cur, i = [], [], None, 0
while i < len(a) and a[i] != "--":
    if a[i] == "R":
        cur = reads
    elif a[i] == "W":
        cur = removes
    elif cur is None:
        die("bad plan")
    else:
        cur.append(a[i])
    i += 1
prog = a[i + 1:]
if not prog:
    die("no command")
apply(reads, removes)
try:
    os.execv(prog[0], prog)
except OSError as e:
    die("exec %s: %s" % (prog[0], e))
`;

/** python3 at a fixed place (never one found on PATH, which a workspace can put first). */
export function landlockPython(
	env: Record<string, string | undefined> = process.env,
	exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
	const prefix = env.PREFIX?.includes("/com.termux/") ? env.PREFIX : undefined;
	for (const p of [
		"/usr/bin/python3",
		"/usr/local/bin/python3",
		"/bin/python3",
		...(prefix ? [path.join(prefix, "bin", "python3")] : []),
		"/data/data/com.termux/files/usr/bin/python3",
	])
		if (exists(p)) return p;
	return undefined;
}

/** The shell the wrapped command runs in: /bin/sh, or Termux's (Android has no /bin/sh). */
export function landlockShell(exists: (p: string) => boolean = fs.existsSync): string {
	for (const p of ["/bin/sh", "/data/data/com.termux/files/usr/bin/sh", "/system/bin/sh"])
		if (exists(p)) return p;
	return "/bin/sh";
}

export type LandlockStatus =
	| { active: true; python: string; abi: number }
	| { active: false; reason: string };

/** What one run of the probe said. `transient`: it timed out or was killed for a reason that may pass. */
export interface ProbeRun {
	status: number | null;
	stdout: string;
	signal: string | null;
	error?: Error;
}

type CachedStatus = { status: LandlockStatus; until: number };
let statusCache: CachedStatus | undefined;

/** A transient failure is remembered this long, then probed again. */
export const TRANSIENT_RETRY_MS = 30_000;

/**
 * Whether the rule can be applied on this host, by running the helper in probe mode: it creates a
 * ruleset and restricts itself. An answer that will not change (it works; there is no Landlock;
 * a seccomp filter kills the call with SIGSYS, as on older Android; there is no python3) is kept
 * for the life of the process. A probe that merely timed out or was killed by something else
 * (a loaded phone, an out-of-memory kill) is not: it is retried after TRANSIENT_RETRY_MS, so one
 * slow start cannot leave the whole session without the rule (8SO, #4898).
 */
export function landlockStatus(
	platform: string = process.platform,
	run: (python: string) => ProbeRun = realProbe,
	now: () => number = Date.now,
): LandlockStatus {
	if (statusCache && statusCache.until > now()) return statusCache.status;
	const { status, transient } = probeStatus(platform, run);
	statusCache = {
		status,
		until: transient ? now() + TRANSIENT_RETRY_MS : Number.POSITIVE_INFINITY,
	};
	return status;
}

/** Test hook: forget the probe result. */
export function _resetLandlockStatus(): void {
	statusCache = undefined;
}

function realProbe(python: string): ProbeRun {
	const r = spawnSync(python, ["-I", "-S", "-c", LANDLOCK_HELPER, "probe"], {
		encoding: "utf8",
		timeout: 5000,
	});
	return { status: r.status, stdout: r.stdout ?? "", signal: r.signal, error: r.error };
}

function probeStatus(
	platform: string,
	run: (python: string) => ProbeRun,
): { status: LandlockStatus; transient: boolean } {
	const no = (reason: string, transient = false) => ({
		status: { active: false, reason } as LandlockStatus,
		transient,
	});
	if (platform !== "linux" && platform !== "android") return no(`no Landlock on ${platform}`);
	const python = landlockPython();
	if (!python) return no("python3 not found (the Landlock helper needs it)");
	let r: ProbeRun;
	try {
		r = run(python);
	} catch (e) {
		return no(`the Landlock probe failed: ${(e as Error).message}`, true);
	}
	const abi = Number.parseInt((r.stdout ?? "").trim(), 10);
	if (r.status === 0 && abi >= 1)
		return { status: { active: true, python, abi }, transient: false };
	if (r.signal === "SIGSYS") return no("a seccomp filter blocks Landlock here (SIGSYS)");
	if (r.error || r.signal) {
		const why = r.error ? r.error.message : `killed (${r.signal})`;
		return no(`the Landlock probe did not finish (${why}); it will be tried again`, true);
	}
	return no("this kernel does not support Landlock");
}

/** argv to put in front of `<shell> -c <command>`: the helper with this command's grant lists. */
export function landlockArgv(python: string, plan: LandlockPlan): string[] {
	return [python, "-I", "-S", "-c", LANDLOCK_HELPER, "R", ...plan.read, "W", ...plan.remove, "--"];
}
