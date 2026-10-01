/**
 * Owner-identity scan for the shipped bundles (#3282).
 *
 * v0.18.0 shipped dist/cli.js and dist/tui.js with the maintainer's full name
 * and personal email hardcoded in the PII anonymizer. That is personal data in
 * a public artifact, and it made the anonymizer protect the maintainer instead
 * of whoever is running the build. The owner identity must only ever come from
 * the running user at runtime.
 *
 * This scan is the release gate for that rule, in the same spirit as the
 * build-path scan in pack-smoke: it collects the real identities that could
 * plausibly be baked in (the repo's commit authors, the builder's git name and
 * email and profile name, and anything in PACK_SMOKE_OWNER_IDENTITY) and fails if
 * any of them appears as a literal in a bundle. No identity is written here.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A full name (has whitespace) or an email that is not a no-reply address.
 *
 * `trusted` values come only from PACK_SMOKE_OWNER_IDENTITY: a maintainer put
 * them there on purpose, so a single word (a surname, a handle) of 4+
 * characters is scanned too, matched as a whole word. Names from commit
 * authors and from the builder's git config are not trusted that way: a
 * single word there ("Claude", "root", "runner", "Mark") is too generic to
 * scan a 25 MB bundle for.
 */
export function isScannableIdentity(value: string, trusted = false): boolean {
	const v = value.trim();
	if (v.includes("[bot]")) return false;
	if (v.includes("@")) return v.length >= 5 && !/noreply/i.test(v);
	if (/\s/.test(v)) return v.length >= 5;
	return trusted && v.length >= 4;
}

/**
 * Parse `git log --format=%an%x00%ae` output into unique scannable identities.
 */
export function identitiesFromAuthorLog(log: string): string[] {
	const out = new Set<string>();
	for (const line of log.split("\n")) {
		for (const part of line.split("\0")) {
			const v = part.trim();
			if (isScannableIdentity(v)) out.add(v);
		}
	}
	return [...out];
}

/** Commit authors of the repo at `root` (whatever history the checkout has). */
export function repoAuthorIdentities(root: string): string[] {
	const r = spawnSync("git", ["log", "--format=%an%x00%ae"], {
		cwd: root,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return r.status === 0 ? identitiesFromAuthorLog(r.stdout) : [];
}

/** The builder's own 8gent profile name (~/.8gent/user.json identity.name). */
export function profileIdentity(home: string): string[] {
	try {
		const user = JSON.parse(readFileSync(join(home, ".8gent", "user.json"), "utf-8"));
		const name = typeof user?.identity?.name === "string" ? user.identity.name : "";
		return isScannableIdentity(name) ? [name.trim()] : [];
	} catch {
		return [];
	}
}

/** Extra identities from a comma-separated env value. */
export function envIdentities(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => isScannableIdentity(v, true));
}

/**
 * The building user's git identity (`git config user.name` / `user.email`, as
 * git resolves them in `root`: local, then global, then system). Run with the
 * builder's real environment, not the isolated install HOME.
 */
export function builderIdentities(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const out: string[] = [];
	for (const key of ["user.name", "user.email"]) {
		const r = spawnSync("git", ["config", key], { cwd: root, encoding: "utf-8", env });
		const v = r.status === 0 ? r.stdout.trim() : "";
		// Untrusted: a git user.name must be a full name (has a space).
		if (v && isScannableIdentity(v)) out.push(v);
	}
	return out;
}

/**
 * Every identity the release gate scans for: commit authors, the builder's git
 * identity and profile name, and PACK_SMOKE_OWNER_IDENTITY (set in CI from a
 * repository secret, so the gate does not depend on who builds).
 */
export function collectOwnerIdentities(opts: {
	root: string;
	home: string;
	env?: NodeJS.ProcessEnv;
}): string[] {
	const env = opts.env ?? process.env;
	return [
		...new Set([
			...repoAuthorIdentities(opts.root),
			...builderIdentities(opts.root, env),
			...profileIdentity(opts.home),
			...envIdentities(env.PACK_SMOKE_OWNER_IDENTITY),
		]),
	];
}

/**
 * Identities from `identities` that appear in `src`. Emails match
 * case-insensitively, full names exactly, single words as whole words.
 */
export function findOwnerIdentity(src: string, identities: string[]): string[] {
	const lower = src.toLowerCase();
	return [...new Set(identities)].filter((id) => {
		if (id.includes("@")) return lower.includes(id.toLowerCase());
		if (/\s/.test(id)) return src.includes(id);
		// A single word (surname, handle): whole-word only.
		return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(id)}(?![A-Za-z0-9_])`).test(src);
	});
}

/** Mask an identity for logs: keep two characters (and two of an email domain). */
export function maskIdentity(value: string): string {
	const at = value.indexOf("@");
	if (at > 0) return `${value.slice(0, 2)}***@${value.slice(at + 1, at + 3)}***`;
	return `${value.slice(0, 2)}***`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
