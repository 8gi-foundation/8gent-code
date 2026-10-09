/**
 * Commands a person must approve every time (#3748).
 *
 * The safe list auto-approves a command by how it starts. Three kinds of
 * command need a person whatever the safe list, --yes or a guarded mode say,
 * and are refused when no terminal is attached:
 *
 * - a `git push` whose target is the default branch (main, master, or the
 *   repository's configured default; a bare push counts when the current
 *   branch is one of them);
 * - a network command that sends data: a request body, a form or file upload,
 *   a non-GET method, a write through `gh issue` / `gh pr`, or output
 *   redirected to a network socket;
 * - any network command at all while the user has pinned a local provider.
 *
 * Every segment of a command line is checked (pipes, &&, ||, ;), and a quoted
 * inner command (`sh -c "..."`) is checked as a command line of its own.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { splitPipeline, tokenize } from "./src/workspace-boundary";

/** What the push check needs to know about the repository. */
export interface GitState {
	/** The checked-out branch, or null when unknown or detached. */
	currentBranch(dir?: string): string | null;
	/** Branch names that count as the default branch. */
	defaultBranches(dir?: string): string[];
}

export interface CommandPolicyContext {
	git: GitState;
	/** The user pinned a local provider: every network command asks. */
	pinnedLocalProvider: boolean;
}

const NETWORK_TOOLS = new Set(["curl", "wget"]);
const GH_NETWORK = new Set(["api", "issue", "pr"]);
const GH_READ_ONLY = new Set(["list", "view", "status", "checks", "diff", "checkout"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "sudo", "xargs"]);

/** `2>&1` and `&>` are redirects, not the `&` sequencing operator. */
function normaliseRedirects(command: string): string {
	return command.replace(/\d*>&\d+/g, " ").replace(/&>/g, ">");
}

/** Segments of a command line, with redirect operators kept out of the split. */
export function commandSegments(command: string): string[] {
	return splitPipeline(normaliseRedirects(command));
}

/** argv with leading VAR=value assignments and wrapper commands removed. */
function stripPrefix(argv: string[]): string[] {
	let i = 0;
	while (i < argv.length) {
		const t = argv[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			i++;
			continue;
		}
		if (WRAPPERS.has(path.basename(t))) {
			i++;
			// Skip the wrapper's own flags (and xargs -n 1 style values).
			while (i < argv.length && argv[i].startsWith("-")) {
				i += /^-[nIPLs]$/.test(argv[i]) ? 2 : 1;
			}
			continue;
		}
		break;
	}
	return argv.slice(i);
}

// ── git push ──────────────────────────────────────────────────────────────

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_OPTS_WITH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

/** The default-branch push check for one argv (already stripped of prefixes). */
export function pushTargetsDefaultBranch(argv: string[], git: GitState): boolean {
	if (path.basename(argv[0] ?? "") !== "git") return false;
	let i = 1;
	let dir: string | undefined;
	while (i < argv.length && argv[i].startsWith("-")) {
		if (argv[i] === "-C") dir = argv[i + 1];
		i += GIT_GLOBAL_WITH_VALUE.has(argv[i]) ? 2 : 1;
	}
	if (argv[i] !== "push") return false;

	const positionals: string[] = [];
	let tagsOnly = false;
	for (let j = i + 1; j < argv.length; j++) {
		const a = argv[j];
		if (a === "--all" || a === "--mirror" || a === "--branches") return true;
		if (a === "--tags") tagsOnly = true;
		if (PUSH_OPTS_WITH_VALUE.has(a)) {
			j++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positionals.push(a);
	}

	const defaults = new Set(git.defaultBranches(dir).map((b) => b.toLowerCase()));
	const isDefault = (b: string | null) => !!b && defaults.has(b.replace(/^refs\/heads\//, "").toLowerCase());

	const refspecs = positionals.slice(1);
	// `git push --tags` with no refspec pushes tags, not the current branch.
	if (refspecs.length === 0) return !tagsOnly && isDefault(git.currentBranch(dir));
	return refspecs.some((spec) => {
		const s = spec.replace(/^\+/, "");
		const colon = s.indexOf(":");
		const dst = colon >= 0 ? s.slice(colon + 1) : s;
		if (dst === "HEAD" || dst === "@") return isDefault(git.currentBranch(dir));
		return isDefault(dst);
	});
}

// ── network ───────────────────────────────────────────────────────────────

function nonGetMethod(m: string | undefined): boolean {
	return !!m && !/^(get|head|options)$/i.test(m);
}

/** "send" when this argv sends data, "fetch" when it only reads, null when it is not a network command. */
export function networkUse(argv: string[]): "send" | "fetch" | null {
	const tool = path.basename(argv[0] ?? "");
	const args = argv.slice(1);

	if (tool === "curl") {
		for (let j = 0; j < args.length; j++) {
			const a = args[j];
			if (/^--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string|upload-file)(=|$)/.test(a)) {
				return "send";
			}
			if (a === "--request" || a === "-X") {
				if (nonGetMethod(args[j + 1])) return "send";
				continue;
			}
			if (a.startsWith("--request=") && nonGetMethod(a.slice(10))) return "send";
			if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
				const cluster = a.slice(1);
				if (cluster.startsWith("X") && cluster.length > 1) {
					if (nonGetMethod(cluster.slice(1))) return "send";
					continue;
				}
				const flags = cluster.match(/^[A-Za-z]+/)?.[0] ?? "";
				if (/[dFT]/.test(flags)) return "send";
			}
		}
		return "fetch";
	}

	if (tool === "wget") {
		for (let j = 0; j < args.length; j++) {
			const a = args[j];
			if (/^--(post-data|post-file|body-data|body-file)(=|$)/.test(a)) return "send";
			if (a === "--method" && nonGetMethod(args[j + 1])) return "send";
			if (a.startsWith("--method=") && nonGetMethod(a.slice(9))) return "send";
		}
		return "fetch";
	}

	if (tool === "gh" && GH_NETWORK.has(args[0] ?? "")) {
		const sub = args[0];
		const rest = args.slice(1);
		if (sub === "api") {
			for (let j = 0; j < rest.length; j++) {
				const a = rest[j];
				if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a)) return "send";
				if ((a === "-X" || a === "--method") && nonGetMethod(rest[j + 1])) return "send";
				if (a.startsWith("--method=") && nonGetMethod(a.slice(9))) return "send";
			}
			return "fetch";
		}
		// gh issue / gh pr: anything but a read sends content to the service.
		const action = rest.find((a) => !a.startsWith("-"));
		return action && GH_READ_ONLY.has(action) ? "fetch" : "send";
	}

	return null;
}

// ── the decision ──────────────────────────────────────────────────────────

/**
 * Why a person must approve this command, or null when the usual rules apply.
 * Plain words: the reason is shown in the prompt and in a refusal.
 */
export function mustAskReason(command: string, ctx: CommandPolicyContext, depth = 0): string | null {
	if (/\/dev\/(tcp|udp)\//i.test(command)) return "it redirects data to a network socket";

	for (const segment of commandSegments(command)) {
		const raw = tokenize(segment);
		// A quoted inner command (sh -c "...") is a command line of its own.
		if (depth < 3) {
			for (const t of raw) {
				if (/\s/.test(t)) {
					const inner = mustAskReason(t, ctx, depth + 1);
					if (inner) return inner;
				}
			}
		}
		const argv = stripPrefix(raw);
		if (argv.length === 0) continue;

		if (pushTargetsDefaultBranch(argv, ctx.git)) return "it pushes to the default branch";

		const use = networkUse(argv);
		if (use === "send") return "it sends data over the network";
		if (use === "fetch" && ctx.pinnedLocalProvider) {
			return "it reaches the network while a local provider is pinned";
		}
	}
	return null;
}

/**
 * Whether every segment of a command line passes `isSafe` (#3748). A `cd`
 * segment only moves the shell; its target is checked by the workspace
 * boundary, so it never makes a line unsafe on its own.
 */
export function everySegmentSafe(command: string, isSafe: (segment: string) => boolean): boolean {
	const segments = commandSegments(command);
	if (segments.length === 0) return false;
	return segments.every((s) => /^cd(\s|$)/.test(s) || isSafe(s));
}

// ── git state from the repository ─────────────────────────────────────────

function git(dir: string, args: string[]): string | null {
	try {
		const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 2000 });
		return r.status === 0 ? r.stdout.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Git state read from the repository: the current branch, and main, master
 * and origin's HEAD as the default branches. Cached per directory for a few
 * seconds, since one command is checked several times.
 */
export function repoGitState(baseDir: () => string = () => process.env.EIGHT_WORKSPACE_ROOT || process.cwd()): GitState {
	const cache = new Map<string, { at: number; current: string | null; defaults: string[] }>();
	const read = (dir?: string) => {
		const d = path.resolve(baseDir(), dir ?? ".");
		const hit = cache.get(d);
		if (hit && Date.now() - hit.at < 5000) return hit;
		const current = git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const originHead = git(d, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
		const defaults = ["main", "master"];
		if (originHead) defaults.push(originHead.replace(/^origin\//, ""));
		const entry = { at: Date.now(), current: current && current !== "HEAD" ? current : null, defaults };
		cache.set(d, entry);
		return entry;
	};
	return {
		currentBranch: (dir) => read(dir).current,
		defaultBranches: (dir) => read(dir).defaults,
	};
}

/** Providers that run on the user's machine. */
export const LOCAL_PROVIDERS = new Set(["8gent", "ollama", "lmstudio", "llama-server", "apfel", "apple-foundation"]);

/** EIGHT_PROVIDERS_ALLOW names only local providers: a pinned local setup by config. */
export function allowListIsLocalOnly(value: string | undefined): boolean {
	const list = (value ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return list.length > 0 && list.every((p) => LOCAL_PROVIDERS.has(p));
}
