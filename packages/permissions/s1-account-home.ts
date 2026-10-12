/**
 * The account's home directory from the account database, never from $HOME (#4073).
 *
 * Bun's os.userInfo() follows $HOME, so a run whose HOME sits inside its own run
 * directory made that directory look like an ancestor of the home, and `echo ~`
 * does not consult the database under dash. So read the database itself:
 * `dscl . -read /Users/<name> NFSHomeDirectory` on macOS, `getent passwd <uid>`
 * (then /etc/passwd) elsewhere, each with a fixed argv, an empty environment and
 * a short timeout. Null when none can be read; callers then fall back.
 *
 * Synchronous, never throws.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

type HomeLookup = string | null | (() => string | undefined);
let passwdHomeOverride: HomeLookup | undefined;
/** Tests only: stand in for the account's home lookup. Inert unless NODE_ENV is "test". */
export function _setPasswdHomeForTests(h: HomeLookup | undefined): void {
	if (process.env.NODE_ENV !== "test") return;
	passwdHomeOverride = h;
}

const goodHome = (h: string | undefined): string | null =>
	h && h.startsWith("/") && h !== "/" && !/[\n\r\0]/.test(h) ? h : null;

/** Home for `uid` from passwd-format text (getent output or /etc/passwd). */
export function homeFromPasswd(text: string, uid: number): string | null {
	for (const line of text.split("\n")) {
		const f = line.split(":");
		if (f.length >= 6 && f[2] === String(uid)) return goodHome(f[5]);
	}
	return null;
}

/** Home from `dscl . -read /Users/<name> NFSHomeDirectory` output. */
export function homeFromDscl(text: string): string | null {
	const m = /^NFSHomeDirectory:[ \t]*(\S.*)$/m.exec(text);
	return goodHome(m?.[1]?.trim());
}

export type RunTool = (file: string, args: string[]) => string;

const runTool: RunTool = (file, args) =>
	execFileSync(file, args, {
		encoding: "utf8",
		timeout: 2000,
		stdio: ["ignore", "pipe", "ignore"],
		env: {},
	});

/** The database lookup for `platform`, with the tool runner and file reader injectable for tests. */
export function passwdHomeFor(
	platform: NodeJS.Platform,
	uid: number,
	run: RunTool = runTool,
	readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
	userName: () => string = () => run("/usr/bin/id", ["-un"]).trim(),
): string | null {
	try {
		if (platform === "darwin") {
			const name = userName();
			if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
			try {
				const h = homeFromDscl(run("/usr/bin/dscl", [".", "-read", `/Users/${name}`, "NFSHomeDirectory"]));
				if (h) return h;
			} catch {
				// directory service unreachable (e.g. inside a sandbox): macOS sh expands ~ from the same database
			}
			return goodHome(run("/bin/sh", ["-c", "echo ~"]).trim());
		}
		for (const bin of ["/usr/bin/getent", "/bin/getent"]) {
			try {
				const h = homeFromPasswd(run(bin, ["passwd", String(uid)]), uid);
				if (h) return h;
			} catch {
				// try the next location
			}
		}
		return homeFromPasswd(readFile("/etc/passwd"), uid);
	} catch {
		return null;
	}
}

let cache: string | null | undefined;

export function passwdHome(): string | null {
	if (cache !== undefined) return cache;
	cache = null;
	try {
		if (typeof process.getuid === "function") cache = passwdHomeFor(process.platform, process.getuid());
	} catch {
		// no opinion
	}
	return cache;
}

/** The account's home directory, or undefined when it cannot be determined. */
export function accountHome(): string | undefined {
	try {
		if (passwdHomeOverride !== undefined) {
			const v = typeof passwdHomeOverride === "function" ? passwdHomeOverride() : passwdHomeOverride;
			return v ?? undefined;
		}
		return passwdHome() ?? userInfo().homedir;
	} catch {
		return undefined;
	}
}
