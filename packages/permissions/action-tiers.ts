/**
 * Action tiers (Owned Duet, #5233 slice 1): free, gated, blocked.
 *
 * Every action an officer proposes is classified here BEFORE a person sees it.
 *   free     no side effect outside the prepared dir (accepting a draft)
 *   gated    has an effect; runs only after an explicit approve (diff in a worktree)
 *   blocked  refused, even if the owner approves it: unlisted action kinds
 *            (deny by default), secrets, personal data, protected paths,
 *            commands the policy engine denies.
 * A packet from untrusted input is never free.
 */

import { containsPii } from "./pii-anonymizer.js";
import { checkCommand } from "./policy-engine.js";
import { hasSecret } from "./secret-detector.js";

export type ActionTier = "free" | "gated" | "blocked";

export interface TieredAction {
	kind: string;
	target: string;
	payload: string;
	/** Exact shell command that runs on approve, if any. */
	command?: string;
}

export interface TierDecision {
	tier: ActionTier;
	reason: string;
}

export const FREE_ACTIONS: ReadonlySet<string> = new Set(["accept_draft"]);
export const GATED_ACTIONS: ReadonlySet<string> = new Set(["apply_diff_worktree"]);

/**
 * A diff may never touch these, however it was approved. Matched against a
 * lower-cased, normalised path, so `.GitHub/` on a case-insensitive disk is
 * still `.github/`. CI config, hooks, the package manifest, the lockfiles and
 * bun's config are here because each one runs code the gate would execute.
 */
const PROTECTED_PATH = [
	/(^|\/)\.git(\/|$)/,
	/(^|\/)git~\d/,
	/(^|\/)\.env/,
	/(^|\/)\.github(\/|$)/,
	/(^|\/)\.forgejo(\/|$)/,
	/(^|\/)\.gitea(\/|$)/,
	/(^|\/)\.gitlab(\/|$)/,
	/(^|\/)\.gitlab-ci\.ya?ml$/,
	/(^|\/)\.circleci(\/|$)/,
	/(^|\/)\.husky(\/|$)/,
	/(^|\/)\.githooks(\/|$)/,
	/(^|\/)\.git-hooks(\/|$)/,
	/(^|\/)\.lefthook(\/|$)/,
	/(^|\/)lefthook(-local)?\.ya?ml$/,
	/(^|\/)\.pre-commit-config\.ya?ml$/,
	/(^|\/)\.gitmodules$/,
	/(^|\/)\.gitattributes$/,
	/(^|\/)package\.json$/,
	/(^|\/)bunfig\.toml$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.yarnrc(\.ya?ml)?$/,
	/(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
	/^packages\/permissions(\/|$)/,
	/^architecture\.rules\.json$/,
];

/** Git's C-style quoting: "a\tb", "\303\251", "\"". Returns the raw bytes decoded as UTF-8. */
function unquote(s: string): string {
	if (!s.startsWith('"')) return s;
	const bytes: number[] = [];
	const esc: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
	for (let i = 1; i < s.length; i++) {
		const c = s[i];
		if (c === '"') break;
		if (c !== "\\") {
			bytes.push(...Buffer.from(c, "utf8"));
			continue;
		}
		const n = s[++i];
		if (n !== undefined && /[0-7]/.test(n)) {
			const oct = /^[0-7]{1,3}/.exec(s.slice(i))![0];
			bytes.push(Number.parseInt(oct, 8) & 0xff);
			i += oct.length - 1;
		} else if (n !== undefined && n in esc) bytes.push(esc[n]);
		else if (n !== undefined) bytes.push(...Buffer.from(n, "utf8"));
	}
	return Buffer.from(bytes).toString("utf8");
}

/** One path token: quoted (to its closing quote) or bare (to the end). */
const TOKEN = String.raw`("(?:[^"\\]|\\.)*"|.+)`;

/**
 * Every path a unified or git diff names: diff --git headers (bare or quoted),
 * ---/+++ lines, and rename/copy from/to lines, which git applies without any
 * ---/+++ line at all.
 */
export function diffPaths(diff: string): string[] {
	const out: string[] = [];
	// git apply strips the first component (-p1) whatever it is, so keep the
	// path both with and without it: a check that misses either is a bypass.
	const add = (raw: string) => {
		const p = unquote(raw.trim());
		if (!p || p === "/dev/null") return;
		out.push(p);
		const cut = p.indexOf("/");
		if (cut > 0) out.push(p.slice(cut + 1));
	};
	for (const line of diff.split(/\r?\n/)) {
		let m = new RegExp(`^(?:\\+\\+\\+|---) ${TOKEN}$`).exec(line);
		if (m) {
			add(m[1].startsWith('"') ? m[1] : m[1].replace(/\t.*$/, ""));
			continue;
		}
		m = new RegExp(`^(?:rename|copy) (?:from|to) ${TOKEN}$`).exec(line);
		if (m) {
			add(m[1]);
			continue;
		}
		if (line.startsWith("diff --git ")) {
			const rest = line.slice("diff --git ".length);
			const q = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(rest);
			if (q) {
				add(q[1]);
				add(q[2]);
			}
			// A bare header with spaces in its names is ambiguous; take every split too.
			const bare = /^a\/(.+) b\/(.+)$/.exec(rest);
			if (bare) {
				add(`a/${bare[1]}`);
				add(`b/${bare[2]}`);
			}
		}
	}
	return out;
}

/** The lines that name paths: diff --git, rename/copy, and ---/+++ header pairs. */
function diffHeaderLines(diff: string): string[] {
	const lines = diff.split(/\r?\n/);
	const out: string[] = [];
	lines.forEach((l, i) => {
		if (/^(diff --git |rename (from|to) |copy (from|to) )/.test(l)) out.push(l);
		else if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) out.push(l, lines[i + 1]);
	});
	return out;
}

/** Lower-case, drop the zero-width code points HFS+ ignores, and normalise slashes. */
function normalisePath(p: string): string {
	return p
		.normalize("NFC")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(\.\/)+/, "")
		.toLowerCase();
}

/**
 * The allowlist, checked first; PROTECTED_PATH stays as the second layer.
 * A denylist matched after case and Unicode folding keeps losing to the disk's
 * own folding (APFS maps \u017f to s, \u00df to ss, \ufb01 to fi), so a Duet diff may
 * only name plain source and docs: pure ASCII from [A-Za-z0-9._/-], no
 * component starting with a dot, one of a few extensions, JSON only as a test
 * fixture, and never a tool config, manifest or lockfile, whatever its case.
 */
const ALLOWED_CHARS = /^[A-Za-z0-9._/-]+$/;
const ALLOWED_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".mdx", ".txt", ".css", ".json"]);
/** Tool configs and manifests the gate would read, matched as a basename prefix in any case. */
export const CONFIG_NAMES = [
	"package",
	"tsconfig",
	"jsconfig",
	"bunfig",
	"biome",
	"eslint",
	"vite",
	"vitest",
	"next",
	"tailwind",
	"postcss",
	"babel",
	"webpack",
	"rollup",
	"jest",
	"playwright",
	"prettier",
	"turbo",
] as const;
const CONFIG_BASENAME = new RegExp(`^(${CONFIG_NAMES.join("|")})[^/]*$`, "i");
const LOCKFILE =
	/^(npm-shrinkwrap|package-lock|pnpm-lock|bun\.lockb?|yarn\.lock|deno\.lock|composer\.lock|cargo\.lock|gemfile\.lock|poetry\.lock)/i;

/** Why `p` is not on the Duet allowlist, or "" when it is. */
export function allowlistViolation(p: string): string {
	if (!ALLOWED_CHARS.test(p))
		return "only ASCII letters, digits, '.', '_', '-' and '/' are allowed";
	const parts = p.split("/");
	if (parts.some((c) => c === "")) return "empty path component";
	if (parts.some((c) => c.startsWith("."))) return "a path component starts with '.'";
	if (parts.some((c) => c.toLowerCase() === "node_modules")) return "node_modules is not allowed";
	const base = parts[parts.length - 1];
	if (CONFIG_BASENAME.test(base)) return "tool config and manifests are not allowed";
	if (LOCKFILE.test(base)) return "lockfiles are not allowed";
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot) : "";
	if (!ALLOWED_EXT.has(ext)) return `extension "${ext || "(none)"}" is not allowed`;
	if (
		ext === ".json" &&
		!parts.slice(0, -1).some((c) => c === "__fixtures__" || c === "fixtures")
	) {
		return ".json is allowed only under __fixtures__/ or fixtures/";
	}
	return "";
}

/** The only file modes a Duet diff may carry: a regular file, plain or executable. */
const REGULAR_MODES: ReadonlySet<number> = new Set([0o100644, 0o100755]);

/**
 * Why the diff's git headers carry a mode or object that is not a regular
 * file (symlink 120000, gitlink 160000, binary), or "" when they do not.
 * git reads a mode with strtoul(..., 8), so "0120000" and "00000120000" are
 * both a symlink: every mode is parsed as octal here, never matched as text.
 * This is the first layer; the apply command re-checks the staged index with
 * git's own parser before the gate runs.
 */
export function modeViolation(diff: string): string {
	for (const line of diff.split(/\r?\n/)) {
		let raw: string | undefined;
		const m = /^(?:new file mode|old mode|new mode|deleted file mode)\s(.*)$/.exec(line);
		if (m) raw = m[1];
		else {
			const ix = /^index [^ ]*\.\.[^ ]*(?: (.*))?$/.exec(line);
			if (ix) {
				if (ix[1] === undefined) continue;
				raw = ix[1];
			}
		}
		if (raw !== undefined) {
			const t = raw.trim();
			if (!/^[0-7]+$/.test(t)) return `diff header mode is not plain octal: ${line}`;
			if (!REGULAR_MODES.has(Number.parseInt(t, 8))) {
				return `only regular file modes 100644 and 100755 are allowed: ${line}`;
			}
			continue;
		}
		if (/^[-+ ]?Subproject commit /.test(line)) return "a submodule (gitlink) is not allowed";
		if (/^GIT binary patch/.test(line) || /^Binary files .* differ/.test(line)) {
			return "a binary patch is not allowed";
		}
	}
	return "";
}

export function isProtectedPath(p: string): boolean {
	const n = normalisePath(p);
	return PROTECTED_PATH.some((re) => re.test(n));
}

export function classifyAction(
	action: TieredAction,
	opts: { untrusted?: boolean } = {},
): TierDecision {
	const blocked = (reason: string): TierDecision => ({ tier: "blocked", reason });
	const free = FREE_ACTIONS.has(action.kind);
	const gated = GATED_ACTIONS.has(action.kind);
	if (!free && !gated) {
		return blocked(`action kind "${action.kind}" is not listed; deny by default`);
	}
	const body = `${action.payload}\n${action.command ?? ""}`;
	if (hasSecret(body)) return blocked("payload carries a secret");
	// For a diff, only the lines it adds can leak someone's data; index hashes and context are not content.
	const scanned = gated
		? action.payload
				.split("\n")
				.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
				.join("\n")
		: action.payload;
	if (containsPii(scanned)) return blocked("payload carries personal data");

	if (gated) {
		const why = modeViolation(action.payload);
		if (why) return blocked(why);
		const paths = diffPaths(action.payload);
		if (paths.length === 0) return blocked("diff names no paths; refused");
		const quoted = diffHeaderLines(action.payload).find((l) => /["\\]/.test(l));
		if (quoted !== undefined) return blocked(`diff path is quoted or escaped: ${quoted}`);
		for (const p of paths) {
			const why = allowlistViolation(p);
			if (why) return blocked(`diff path not on the allowlist: ${JSON.stringify(p)} (${why})`);
		}
		for (const p of paths) {
			const n = normalisePath(p);
			if (n.startsWith("/") || /^[a-z]:/.test(n) || n.split("/").includes("..")) {
				return blocked(`diff path escapes the worktree: ${p}`);
			}
			if (isProtectedPath(p)) {
				return blocked(`diff touches a protected path: ${p}`);
			}
		}
		if (action.command) {
			const verdict = checkCommand(action.command);
			if (!verdict.allowed) return blocked(`command refused: ${verdict.reason ?? "policy"}`);
		}
		return { tier: "gated", reason: "applies in a worktree after approve" };
	}
	if (opts.untrusted) {
		return { tier: "gated", reason: "untrusted origin is never free" };
	}
	return { tier: "free", reason: "no side effect outside the prepared dir" };
}
