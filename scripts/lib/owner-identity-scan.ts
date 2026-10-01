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
 * plausibly be baked in (the repo's commit authors, plus the builder's own
 * profile name, plus anything passed in PACK_SMOKE_OWNER_IDENTITY) and fails if
 * any of them appears as a literal in a bundle. No identity is written here.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A full name (has whitespace) or an email that is not a no-reply address. */
export function isScannableIdentity(value: string): boolean {
	const v = value.trim();
	if (v.length < 5) return false;
	if (v.includes("[bot]")) return false;
	if (v.includes("@")) return !/noreply/i.test(v);
	// Single words ("Claude", a handle) are too generic to scan a 25 MB bundle for.
	return /\s/.test(v);
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
		.filter(isScannableIdentity);
}

/**
 * Identities from `identities` that appear in `src`. Emails match
 * case-insensitively; names match exactly.
 */
export function findOwnerIdentity(src: string, identities: string[]): string[] {
	const lower = src.toLowerCase();
	return [...new Set(identities)].filter((id) =>
		id.includes("@") ? lower.includes(id.toLowerCase()) : src.includes(id),
	);
}

/** Mask an identity for logs: keep two characters, hide the rest. */
export function maskIdentity(value: string): string {
	const at = value.indexOf("@");
	if (at > 0) return `${value.slice(0, 2)}***@${value.slice(at + 1)}`;
	return `${value.slice(0, 2)}***`;
}
