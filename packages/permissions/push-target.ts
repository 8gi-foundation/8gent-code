/**
 * Where a push that names no destination branch lands, read from the
 * repository: `git push`, `git push origin`, `git push origin HEAD`, the
 * `git_push` tool, and git aliases. Used by isProtectedBranchPush so those
 * pushes get the same protected-branch treatment as `git push origin main`.
 *
 * Anything that cannot be read (no repository, detached HEAD, an unknown
 * push.default, a git that does not answer) comes back as null, which the
 * caller treats as protected.
 */
import { spawnSync } from "node:child_process";
import { PROTECTED_BRANCHES, type PushResolver } from "./go-deny-list.js";

/** One git read in `dir`; null when git fails or does not answer in time. */
function gitRead(dir: string, args: string[]): string | null {
	const r = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf-8",
		timeout: 5000,
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (r.status !== 0 || typeof r.stdout !== "string") return null;
	return r.stdout.trim();
}

/** `git rev-parse --abbrev-ref HEAD`; null for detached HEAD or no repository. */
function currentBranch(dir: string): string | null {
	const branch = gitRead(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch && branch !== "HEAD" ? branch : null;
}

/** `refs/heads/x` and `heads/x` -> `x`. */
function shortRef(ref: string): string {
	return ref.replace(/^(refs\/)?heads\//, "");
}

/**
 * Destinations named by `remote.<name>.push` in the repository's config.
 * A push with no refspec uses them, and `HEAD` maps through them, so every
 * configured remote is included (over-reporting fails closed).
 */
function configuredDestinations(dir: string, branch: string): string[] {
	const out = gitRead(dir, ["config", "--get-regexp", "^remote\\..*\\.push$"]);
	if (!out) return [];
	return out
		.split("\n")
		.map((line) => line.slice(line.indexOf(" ") + 1).trim())
		.filter(Boolean)
		.map((spec) => {
			const dst = (spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec).replace(
				/^\+/,
				"",
			);
			if (dst === "" || dst === "HEAD" || dst === "@") return branch;
			return shortRef(dst);
		});
}

/** Destination branches for a push with no refspec, following push.default. */
function implicitDestinations(dir: string, branch: string): string[] | null {
	const dsts = [branch, ...configuredDestinations(dir, branch)];
	const mode = (gitRead(dir, ["config", "--get", "push.default"]) || "simple").toLowerCase();
	switch (mode) {
		case "nothing":
		case "current":
		// simple pushes to the same name; git refuses when the upstream on
		// that remote has a different name, so it never lands there.
		case "simple":
			return dsts;
		case "matching":
			// Every branch that exists on both sides, protected ones included.
			return [...dsts, "*"];
		case "upstream":
		case "tracking": {
			// The upstream is where these modes push: @{u}, read as the
			// remote-side ref so a remote name with a slash cannot confuse it.
			const merge = gitRead(dir, ["config", "--get", `branch.${branch}.merge`]);
			if (merge) dsts.push(shortRef(merge));
			return dsts;
		}
		default:
			return null;
	}
}

/** Builtins an alias may expand to without pushing. */
const KNOWN_NON_PUSHING = new Set([
	"add",
	"branch",
	"checkout",
	"cherry-pick",
	"commit",
	"diff",
	"fetch",
	"grep",
	"log",
	"merge",
	"pull",
	"rebase",
	"reset",
	"restore",
	"show",
	"stash",
	"status",
	"switch",
	"tag",
]);

export const gitPushResolver: PushResolver = {
	destinations(dir, kind) {
		if (!dir) return null;
		const branch = currentBranch(dir);
		if (!branch) return null;
		if (kind === "head") return [branch, ...configuredDestinations(dir, branch)];
		return implicitDestinations(dir, branch);
	},
	aliasMayPush(dir, name) {
		if (!dir) return true;
		const value = gitRead(dir, ["config", "--get", `alias.${name}`]);
		if (value === null) return false; // not an alias: an external git-<name> command
		// A shell alias (!...) or one that mentions push may push; so may an
		// alias of another alias, or of anything not known to stay local.
		if (value.startsWith("!") || /\bpush\b/.test(value)) return true;
		return !KNOWN_NON_PUSHING.has(value.split(/\s+/)[0] ?? "");
	},
};

/**
 * The branch a `git_push` tool call lands on, for the policy engine and
 * maker-checker context: the first protected destination if there is one,
 * otherwise the first destination; null when it cannot be worked out.
 */
export function pushDestinationBranch(dir: string, kind: "implicit" | "head"): string | null {
	const dsts = gitPushResolver.destinations(dir, kind);
	if (!dsts || dsts.length === 0) return null;
	return dsts.find((d) => d === "*" || PROTECTED_BRANCHES.includes(d.toLowerCase())) ?? dsts[0];
}
