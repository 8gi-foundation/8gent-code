/**
 * Next release version and the version-file edits (#3658).
 *
 * On 1 Oct 2026 auto-release.yml tagged v0.18.1 and v0.19.0, then pushed its
 * bump commit straight to main. The main ruleset rejected that push, so
 * package.json stayed at 0.18.0 and every later run read 0.18.0, computed
 * 0.18.1 and died on "tag 'v0.18.1' already exists".
 *
 * The next version is therefore computed from max(package.json, highest v*
 * tag in the same major line), bumped, and then moved past any tag that
 * already exists. 0.18.0 with {v0.18.1, v0.19.0} gives 0.19.1, and no tag
 * can wedge the pipeline again.
 *
 * Only tags in package.json's major line count as the base: tags v1.0.0 to
 * v2.1.0 from the pre-reset history (March 2026) are still on origin and must
 * never pull the 0.x line up to 2.1.1.
 *
 * Pure functions only; git and file IO live in scripts/release-version.ts.
 */

export type Bump = "patch" | "minor" | "major";
export const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

/** [major, minor, patch] */
export type Semver = readonly [number, number, number];

export function parseSemver(text: string): Semver | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatSemver(v: Semver): string {
	return `${v[0]}.${v[1]}.${v[2]}`;
}

export function compareSemver(a: Semver, b: Semver): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

export function bumpSemver(v: Semver, bump: Bump): Semver {
	switch (bump) {
		case "major":
			return [v[0] + 1, 0, 0];
		case "minor":
			return [v[0], v[1] + 1, 0];
		default:
			return [v[0], v[1], v[2] + 1];
	}
}

/**
 * Release tags as versions. Only `vX.Y.Z` counts; `desktop-v0.1.0`,
 * `proxy-v1.2.3` and pre-release suffixes belong to other lines.
 */
export function releaseVersions(tags: Iterable<string>): Semver[] {
	const out: Semver[] = [];
	for (const tag of tags) {
		const t = tag.trim();
		if (!t.startsWith("v")) continue;
		const v = parseSemver(t);
		if (v) out.push(v);
	}
	return out;
}

/**
 * The release the next one follows: the highest of package.json's version and
 * every release tag in its major line. Returned as X.Y.Z.
 */
export function releaseBase(current: string, tags: Iterable<string>): string {
	const cur = parseSemver(current);
	if (!cur) throw new Error(`package.json version is not X.Y.Z: ${JSON.stringify(current)}`);
	let base = cur;
	for (const v of releaseVersions(tags)) {
		if (v[0] === cur[0] && compareSemver(v, base) > 0) base = v;
	}
	return formatSemver(base);
}

/**
 * Next version: bump the release base, then step the patch number past any
 * tag that already exists, so a stale or orphaned tag can never block a
 * release.
 */
export function nextVersion(current: string, tags: Iterable<string>, bump: Bump): string {
	const all = Array.from(tags);
	const base = parseSemver(releaseBase(current, all)) as Semver;
	const taken = new Set(releaseVersions(all).map(formatSemver));
	let candidate = bumpSemver(base, bump);
	while (taken.has(formatSemver(candidate))) candidate = bumpSemver(candidate, "patch");
	return formatSemver(candidate);
}

/**
 * Bump level from merged PR titles and bodies: `[bump:major]` beats
 * `[bump:minor]` beats the patch default. `feat:` alone stays a patch; a
 * minor or major release is an explicit decision.
 */
export function bumpFromMarkers(text: string): Bump {
	if (/\[bump:major\]/i.test(text)) return "major";
	if (/\[bump:minor\]/i.test(text)) return "minor";
	return "patch";
}

/** Parse a `--bump` value. "auto", "" and undefined mean "read the markers". */
export function parseBump(text: string | undefined): Bump | null {
	const t = (text ?? "").trim().toLowerCase();
	if (t === "" || t === "auto") return null;
	if ((BUMPS as readonly string[]).includes(t)) return t as Bump;
	throw new Error(`--bump must be auto, patch, minor or major, not ${JSON.stringify(text)}`);
}

/** Replace the top-level "version" in package.json text, keeping the formatting. */
export function setPackageVersion(json: string, version: string): string {
	const re = /^(\s*"version":\s*")[^"]*(")/m;
	if (!re.test(json)) throw new Error('package.json has no "version" field');
	return json.replace(re, `$1${version}$2`);
}

/** Replace `const VERSION = "..."` in bin/8gent.ts. */
export function setBinVersion(ts: string, version: string): string {
	const re = /^const VERSION = "[^"]*";/m;
	if (!re.test(ts)) throw new Error('bin/8gent.ts has no `const VERSION = "..."` line');
	return ts.replace(re, `const VERSION = "${version}";`);
}

/**
 * Replace the shields.io version badge in README.md. Returns the text
 * unchanged when there is no badge: the badge is cosmetic, the other two
 * files are not.
 */
export function setReadmeBadge(md: string, version: string): string {
	return md
		.replace(/(img\.shields\.io\/badge\/version-)\d+\.\d+\.\d+(-)/g, `$1${version}$2`)
		.replace(/(alt=")v\d+\.\d+\.\d+(")/g, `$1v${version}$2`);
}
