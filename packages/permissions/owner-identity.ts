/**
 * 8gent Code - the running user's identity, for the PII anonymizer.
 *
 * The anonymizer always masks the owner's own name and email before anything
 * goes to a cloud provider. "Owner" means the person running this copy of
 * 8gent, never the person who built it, so nothing about any real person is
 * written into the source or the bundle. It is read at runtime from the
 * sources onboarding already uses:
 *
 *   - name:  ~/.8gent/user.json `identity.name` (the onboarding profile, which
 *            onboarding seeds from `git config --global user.name`), falling
 *            back to `git config --global user.name` when the profile has none.
 *   - email: `git config --global user.email` (the email onboarding detects;
 *            the profile does not store one).
 *
 * Read-only and local: one small file read and at most two `git config` calls
 * (no shell, a minimal environment), no network. The result is cached and
 * re-read only when HOME, the git global config path, the git global config
 * file's mtime or size, or the profile file's mtime changes, so a name given
 * during onboarding or a mid-session `git config --global` change is picked up
 * without a restart. Nothing is written.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OwnerIdentity {
	/** The owner's name as they gave it, or null when none is configured. */
	name: string | null;
	/** Where the name came from: the onboarding profile or git config. */
	nameSource: "profile" | "git" | null;
	/** The owner's email, or null when none is configured. */
	email: string | null;
}

const GIT_TIMEOUT_MS = 2000;

let cache: { key: string; identity: OwnerIdentity } | null = null;

function homeDir(): string {
	return process.env.HOME || homedir();
}

function profilePath(home: string): string {
	return join(home, ".8gent", "user.json");
}

function readProfileName(home: string): string | null {
	try {
		const user = JSON.parse(readFileSync(profilePath(home), "utf-8"));
		const name = user?.identity?.name;
		return typeof name === "string" && name.trim() ? name.trim() : null;
	} catch {
		return null;
	}
}

/**
 * A minimal environment for the git child: enough to find git and resolve the
 * user's global config, nothing else from this process.
 */
function gitEnv(home: string): Record<string, string> {
	const env: Record<string, string> = { HOME: home };
	for (const k of [
		"PATH",
		"USERPROFILE",
		"SYSTEMROOT",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM",
		"XDG_CONFIG_HOME",
	]) {
		const v = process.env[k];
		if (v !== undefined) env[k] = v;
	}
	return env;
}

function readGitGlobal(key: "user.name" | "user.email", home: string): string | null {
	try {
		const out = execFileSync("git", ["config", "--global", key], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			env: gitEnv(home) as NodeJS.ProcessEnv,
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

/**
 * A change stamp for the global git config file(s) git would read: the file
 * named by GIT_CONFIG_GLOBAL, otherwise $XDG_CONFIG_HOME/git/config (default
 * ~/.config/git/config) and ~/.gitconfig. mtime plus size, "-" when absent.
 */
function gitConfigStamp(home: string): string {
	const files = process.env.GIT_CONFIG_GLOBAL
		? [process.env.GIT_CONFIG_GLOBAL]
		: [
				join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"),
				join(home, ".gitconfig"),
			];
	return files
		.map((f) => {
			try {
				const st = statSync(f);
				return `${st.mtimeMs}:${st.size}`;
			} catch {
				return "-";
			}
		})
		.join("|");
}

/** The running user's name and email, or nulls when none is configured. */
export function loadOwnerIdentity(): OwnerIdentity {
	const home = homeDir();
	let mtime = 0;
	try {
		mtime = statSync(profilePath(home)).mtimeMs;
	} catch {}
	const key = [
		home,
		mtime,
		process.env.GIT_CONFIG_GLOBAL ?? "",
		process.env.XDG_CONFIG_HOME ?? "",
		gitConfigStamp(home),
	].join("\0");
	if (cache?.key === key) return cache.identity;

	const profileName = readProfileName(home);
	const gitName = profileName ? null : readGitGlobal("user.name", home);
	const identity: OwnerIdentity = {
		name: profileName ?? gitName,
		nameSource: profileName ? "profile" : gitName ? "git" : null,
		email: readGitGlobal("user.email", home),
	};
	cache = { key, identity };
	return identity;
}
