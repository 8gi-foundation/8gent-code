/**
 * Commands a person must approve every time (#3748).
 *
 * The safe list auto-approves a command by how it starts. Three kinds of
 * command need a person whatever the safe list, --yes or a guarded mode say,
 * and are refused when no terminal is attached:
 *
 * - a `git push` that can land on the default branch (main, master, or the
 *   repository's configured default). That covers an explicit target, a bare
 *   push routed there by configuration (push.default, the branch upstream,
 *   remote.<name>.push), a git alias that expands to push, and targets this
 *   check cannot resolve with confidence (globs, partial ref names, shell
 *   variables, configuration set on the command line or in the environment,
 *   another git dir, work tree, HOME or config location, a shell alias that
 *   runs git or takes arguments, and a git config change earlier on the same
 *   line). Repository state is read fresh for every check, from the working
 *   directory the command runs in (see withCommandDir);
 * - a network command that sends data: a request body, a form or file upload,
 *   a curl config file or stdin-sending protocol, a non-GET method, a gh
 *   command that creates or uploads content (issue, pr, release, gist, repo,
 *   workflow, secret and the like), a raw socket, remote shell or file copy
 *   tool, an interpreter one-liner that opens a connection, a git push to a
 *   URL remote, or output redirected to a network socket (judged on the path
 *   the shell opens, after quote and escape removal);
 * - any network command at all while the user has pinned a local provider,
 *   except a plain curl fetch whose every target is this machine (loopback).
 *
 * Every segment of a command line is checked (pipes, &&, ||, ;), and a quoted
 * inner command (`sh -c "..."`) is checked as a command line of its own.
 * Wrapper commands (env, sudo, xargs, timeout, nice, nohup, stdbuf, time,
 * command, builtin, exec, caffeinate) are unwrapped together with their own
 * options and option values, and the payload of `find -exec` is checked as a
 * command. A wrapper whose options cannot be read with confidence fails
 * closed: the command asks.
 *
 * Infinite mode applies these checks too (#3765). Everything else still runs
 * there without a prompt, but a command this module marks as ask-every-time
 * prompts when a terminal is attached (Enter means No) and is refused with the
 * same plain reason when there is none, exactly as in Ask mode.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { splitPipeline, tokenize } from "./src/workspace-boundary";

/**
 * Git could not be read (an error exit or a timeout). Distinct from a detached
 * HEAD or an unset key: a push check that meets it fails closed and asks.
 */
export class GitStateUnreadable extends Error {
	constructor(what: string) {
		super(`git state could not be read: ${what}`);
		this.name = "GitStateUnreadable";
	}
}

/**
 * What the push check needs to know about the repository. Every method throws
 * GitStateUnreadable when git cannot be read.
 */
export interface GitState {
	/** The checked-out branch, or null when HEAD is detached. */
	currentBranch(dir?: string): string | null;
	/** Branch names that count as the default branch. */
	defaultBranches(dir?: string): string[];
	/** Every value of a git config key (repository and global), [] when unset. */
	config(key: string, dir?: string): string[];
	/** Configured aliases, name (lowercase) to expansion. */
	aliases(dir?: string): Record<string, string>;
}

export interface CommandPolicyContext {
	git: GitState;
	/** The user pinned a local provider: every network command asks. */
	pinnedLocalProvider: boolean;
}

const GH_READ_ONLY = new Set(["list", "view", "status", "checks", "diff", "checkout"]);
/** gh command groups other than api, issue and pr that reach GitHub. */
const GH_GROUPS = new Set([
	"release",
	"gist",
	"repo",
	"workflow",
	"run",
	"secret",
	"variable",
	"label",
	"ssh-key",
	"gpg-key",
	"codespace",
	"project",
	"cache",
	"ruleset",
	"extension",
	"auth",
	"attestation",
	"org",
	"copilot",
]);
/** gh commands that only read, whatever follows them. */
const GH_FETCH_TOP = new Set(["status", "search", "browse"]);
/** Actions in those groups that only read or download. */
const GH_GROUP_READ = new Set([
	...GH_READ_ONLY,
	"download",
	"watch",
	"clone",
	"get",
	"verify",
	"verify-asset",
	"token",
]);

/** `2>&1` and `&>` are redirects, not the `&` sequencing operator. */
function normaliseRedirects(command: string): string {
	return command.replace(/\d*>&\d+/g, " ").replace(/&>/g, ">");
}

/** Segments of a command line, with redirect operators kept out of the split. */
export function commandSegments(command: string): string[] {
	return splitPipeline(normaliseRedirects(command));
}

// ── wrappers ──────────────────────────────────────────────────────────────

interface WrapperSpec {
	/** Options that take a value: the rest of a short token, `--opt=v`, or the next token. */
	withValue: string[];
	/** Options that take no value. */
	noValue: string[];
	/** Options whose value, if any, is attached (`-i{}`, `--opt=v`), never the next token. */
	optionalValue?: string[];
	/** Operands between the options and the command (timeout's duration). */
	operands?: number;
	/** Options after which nothing is executed (`command -v`). */
	noRun?: string[];
	/** Options this check cannot follow: the command asks. */
	unreadable?: string[];
	/** Accept `-<digits>` (nice -10). */
	numericFlag?: boolean;
	/** The wrapped command receives more arguments than the line shows (xargs). */
	appendsArgs?: boolean;
}

const WRAPPERS: Record<string, WrapperSpec> = {
	env: {
		withValue: ["-u", "--unset", "-C", "--chdir"],
		noValue: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug", "-"],
		optionalValue: [
			"--ignore-signal",
			"--default-signal",
			"--block-signal",
			"--list-signal-handling",
		],
		unreadable: ["-S", "--split-string"],
	},
	sudo: {
		withValue: [
			"-u",
			"--user",
			"-g",
			"--group",
			"-C",
			"--close-from",
			"-D",
			"--chdir",
			"-p",
			"--prompt",
			"-r",
			"--role",
			"-t",
			"--type",
			"-T",
			"--command-timeout",
			"-U",
			"--other-user",
			"--host",
		],
		noValue: [
			"-A",
			"--askpass",
			"-b",
			"--background",
			"-E",
			"-H",
			"--set-home",
			"-i",
			"--login",
			"-K",
			"--remove-timestamp",
			"-k",
			"--reset-timestamp",
			"-n",
			"--non-interactive",
			"-P",
			"--preserve-groups",
			"-S",
			"--stdin",
			"-s",
			"--shell",
			"-B",
			"--bell",
			"-N",
			"--no-update",
		],
		optionalValue: ["--preserve-env"],
		// -h is help on its own and a host with a value: ambiguous.
		unreadable: ["-h", "-e", "--edit", "-l", "--list", "-v", "--validate", "-V", "--version"],
	},
	xargs: {
		withValue: [
			"-a",
			"--arg-file",
			"-d",
			"--delimiter",
			"-E",
			"-I",
			"-L",
			"--max-lines",
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-s",
			"--max-chars",
			"--process-slot-var",
			"-J",
			"-R",
			"-S",
		],
		noValue: [
			"-0",
			"--null",
			"-o",
			"--open-tty",
			"-p",
			"--interactive",
			"-r",
			"--no-run-if-empty",
			"-t",
			"--verbose",
			"-x",
			"--exit",
		],
		optionalValue: ["-e", "--eof", "-i", "--replace", "-l"],
		appendsArgs: true,
	},
	timeout: {
		withValue: ["-k", "--kill-after", "-s", "--signal"],
		noValue: ["--preserve-status", "--foreground", "-v", "--verbose", "-f", "-p"],
		operands: 1,
	},
	nice: { withValue: ["-n", "--adjustment"], noValue: [], numericFlag: true },
	nohup: { withValue: [], noValue: [] },
	stdbuf: { withValue: ["-i", "--input", "-o", "--output", "-e", "--error"], noValue: [] },
	time: {
		withValue: ["-f", "--format", "-o", "--output"],
		noValue: [
			"-p",
			"--portability",
			"-a",
			"--append",
			"-q",
			"--quiet",
			"-v",
			"--verbose",
			"-l",
			"-h",
		],
	},
	command: { withValue: [], noValue: ["-p"], noRun: ["-v", "-V"] },
	builtin: { withValue: [], noValue: [] },
	exec: { withValue: ["-a"], noValue: ["-c", "-l"] },
	caffeinate: { withValue: ["-t", "-w"], noValue: ["-d", "-i", "-m", "-s", "-u"] },
};

/** What actually runs once prefixes are removed, and whether its arguments are complete. */
export interface Unwrapped {
	argv: string[];
	/** A wrapper appends arguments the line does not show (xargs). */
	appendsArgs: boolean;
}

/**
 * Consume one wrapper's options and operands. Returns the index of the first
 * token after them, -1 when nothing will be executed, or null when they
 * cannot be read with confidence.
 */
function skipWrapperOptions(argv: string[], start: number, spec: WrapperSpec): number | null {
	const has = (list: string[] | undefined, o: string) => !!list && list.includes(o);
	let i = start;
	while (i < argv.length) {
		const t = argv[i];
		if (t === "--") {
			i++;
			break;
		}
		if (!t.startsWith("-")) break;
		if (t === "-") {
			if (!has(spec.noValue, "-")) break;
			i++;
			continue;
		}
		if (spec.numericFlag && /^-\d+$/.test(t)) {
			i++;
			continue;
		}
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const name = eq >= 0 ? t.slice(0, eq) : t;
			if (has(spec.unreadable, name)) return null;
			if (has(spec.noRun, name)) return -1;
			if (has(spec.withValue, name)) {
				i += eq >= 0 ? 1 : 2;
				continue;
			}
			if (has(spec.optionalValue, name) || (eq < 0 && has(spec.noValue, name))) {
				i++;
				continue;
			}
			return null;
		}
		// A short option cluster: -abc, -uNAME, -n 1.
		let consumedNext = false;
		for (let k = 1; k < t.length; k++) {
			const o = `-${t[k]}`;
			if (has(spec.unreadable, o)) return null;
			if (has(spec.noRun, o)) return -1;
			if (has(spec.withValue, o)) {
				consumedNext = k === t.length - 1;
				break;
			}
			if (has(spec.optionalValue, o)) break;
			if (has(spec.noValue, o)) continue;
			return null;
		}
		i += consumedNext ? 2 : 1;
	}
	if (i > argv.length) return null;
	for (let n = 0; n < (spec.operands ?? 0); n++) {
		if (i >= argv.length) return -1;
		i++;
	}
	return i;
}

/**
 * argv with leading VAR=value assignments and wrapper commands removed, or
 * null when a wrapper's options cannot be read with confidence.
 */
export function stripPrefix(argv: string[]): Unwrapped | null {
	let i = 0;
	let appendsArgs = false;
	while (i < argv.length) {
		const t = argv[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			i++;
			continue;
		}
		const spec = WRAPPERS[path.basename(t)];
		if (!spec) break;
		const next = skipWrapperOptions(argv, i + 1, spec);
		if (next === null) return null;
		if (next === -1) return { argv: [], appendsArgs };
		appendsArgs ||= !!spec.appendsArgs;
		i = next;
	}
	return { argv: argv.slice(i), appendsArgs };
}

/** The commands `find -exec` / `-execdir` / `-ok` / `-okdir` run. */
function findPayloads(argv: string[]): string[][] {
	if (path.basename(argv[0] ?? "") !== "find") return [];
	const out: string[][] = [];
	for (let i = 1; i < argv.length; i++) {
		if (!/^-(exec|execdir|ok|okdir)$/.test(argv[i])) continue;
		const payload: string[] = [];
		let j = i + 1;
		for (; j < argv.length && argv[j] !== ";" && argv[j] !== "+"; j++) payload.push(argv[j]);
		out.push(payload);
		i = j;
	}
	return out;
}

// ── git push ──────────────────────────────────────────────────────────────

const GIT_GLOBAL_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--super-prefix",
	"--attr-source",
]);
const PUSH_OPTS_WITH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
/** Configuration that, set on the command line, can change where a push goes. */
const PUSH_ROUTING_CONFIG = /^(alias\.|push\.|remote\.|branch\.|url\.|include)/i;
/** A token whose value the shell decides at run time. */
const SHELL_EXPANSION = /[$`]/;

/** "refs/heads/main" and "heads/main" both name main; git resolves either. */
function branchName(ref: string): string {
	return ref.replace(/^refs\//, "").replace(/^heads\//, "");
}

export interface PushCheckOptions {
	/** The line does not show every argument (xargs, find -exec {}). */
	appendsArgs?: boolean;
	/** Directory the command runs in, relative to the git state's base; undefined: the base. */
	dir?: string;
	/**
	 * The repository or git configuration this command sees cannot be known
	 * from here (another git dir, HOME, a config change earlier on the line).
	 * A push, or anything that could be an alias, fails closed.
	 */
	unknownRepo?: boolean;
	depth?: number;
}

/**
 * Git commands that are built in. Git never lets an alias shadow one, so a
 * built-in other than push can never push.
 */
const GIT_BUILTINS = new Set(
	(
		"add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore " +
		"check-ref-format checkout cherry cherry-pick clean clone commit commit-graph commit-tree config " +
		"count-objects describe diff diff-files diff-index diff-tree difftool fetch for-each-ref " +
		"format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base " +
		"mergetool mv notes pull range-diff rebase reflog remote repack replace rerere reset restore " +
		"rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule " +
		"switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree " +
		"write-tree"
	).split(" "),
);

/** A git option that points git at another repository or work tree. */
const GIT_REPO_REDIRECT = /^--(git-dir|work-tree)(=|$)/;

/** Aliases that can reach `push`, directly or through other aliases. */
function pushCapableAliases(aliases: Record<string, string>): Set<string> {
	const capable = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, expansion] of Object.entries(aliases)) {
			if (capable.has(name)) continue;
			const words = expansion.toLowerCase().split(/[^a-z0-9_.-]+/);
			if (words.includes("push") || words.some((w) => capable.has(w))) {
				capable.add(name);
				grew = true;
			}
		}
	}
	return capable;
}

/** The key a `-c` / `--config-env` value sets. */
function configKey(value: string): string {
	const eq = value.indexOf("=");
	return eq >= 0 ? value.slice(0, eq) : value;
}

/** The default-branch push check for one argv (already stripped of prefixes). */
export function pushTargetsDefaultBranch(
	argv: string[],
	git: GitState,
	opts: PushCheckOptions = {},
): boolean {
	try {
		return pushCheck(argv, git, opts);
	} catch (err) {
		// The repository could not be read: a push we cannot resolve asks.
		if (err instanceof GitStateUnreadable) return true;
		throw err;
	}
}

function pushCheck(argv: string[], git: GitState, opts: PushCheckOptions): boolean {
	const depth = opts.depth ?? 0;
	if (path.basename(argv[0] ?? "") !== "git") return false;
	if (depth > 5) return true;
	let i = 1;
	let dir = opts.dir;
	let unknownRepo = !!opts.unknownRepo;
	let routedByCommandLine = false;
	while (i < argv.length && argv[i].startsWith("-")) {
		const a = argv[i];
		if (a === "-C") {
			const to = argv[i + 1] ?? "";
			if (!to || SHELL_EXPANSION.test(to) || to.startsWith("~")) unknownRepo = true;
			else dir = path.isAbsolute(to) ? to : path.join(dir ?? ".", to);
		}
		if (GIT_REPO_REDIRECT.test(a)) unknownRepo = true;
		let key: string | null = null;
		if (a === "-c" || a === "--config-env") key = configKey(argv[i + 1] ?? "");
		else if (a.startsWith("--config-env=")) key = configKey(a.slice("--config-env=".length));
		if (key !== null) {
			// An alias defined on the command line: whatever it expands to, ask.
			if (/^alias\./i.test(key)) return true;
			if (PUSH_ROUTING_CONFIG.test(key)) routedByCommandLine = true;
		}
		i += GIT_GLOBAL_WITH_VALUE.has(a) ? 2 : 1;
	}
	const sub = argv[i];
	if (sub === undefined) return false;

	// Push plumbing and `subtree push` update a remote branch too.
	if (sub === "send-pack" || sub === "subtree") {
		if (
			sub === "subtree" &&
			firstPositional(argv.slice(i + 1), SUBTREE_OPTS_WITH_VALUE) !== "push"
		) {
			return false;
		}
		if (routedByCommandLine || unknownRepo || opts.appendsArgs) return true;
		return plumbingPushTargetsDefault(sub, argv.slice(i + 1), git, dir);
	}

	if (sub !== "push") {
		if (GIT_BUILTINS.has(sub)) return false;
		// Not a built-in: possibly an alias, read from a repository we cannot see.
		if (unknownRepo) return true;
		const aliases = git.aliases(dir);
		const expansion = aliases[sub.toLowerCase()];
		if (expansion === undefined) return false;
		if (expansion.trimStart().startsWith("!")) {
			// A shell alias asks when it runs git, is given arguments, or can reach push.
			return (
				/\bgit\b/.test(expansion) ||
				i + 1 < argv.length ||
				pushCapableAliases(aliases).has(sub.toLowerCase())
			);
		}
		const expanded = [...argv.slice(0, i), ...tokenize(expansion), ...argv.slice(i + 1)];
		return pushCheck(expanded, git, { ...opts, dir, unknownRepo, depth: depth + 1 });
	}

	if (routedByCommandLine || unknownRepo || opts.appendsArgs) return true;

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
	if (positionals.some((p) => SHELL_EXPANSION.test(p))) return true;

	const defaults = new Set(git.defaultBranches(dir).map((b) => b.toLowerCase()));
	const isDefault = (b: string | null) => !!b && defaults.has(branchName(b).toLowerCase());
	const current = git.currentBranch(dir);
	const remote = positionals[0] ?? pushRemote(git, current, dir);
	const configured = git.config(`remote.${remote}.push`, dir);

	const refspecs = positionals.slice(1);
	if (refspecs.length === 0) {
		// `git push --tags` with no refspec pushes tags, not the current branch.
		if (tagsOnly) return false;
		if (isDefault(current)) return true;
		const dests = bareDestinations(git, current, configured, dir);
		return dests === "any" || dests.some(isDefault);
	}

	return refspecs.some((spec) => refspecTargetsDefault(spec, isDefault, git, dir, configured));
}

/** Whether one refspec can update a default branch. */
function refspecTargetsDefault(
	spec: string,
	isDefault: (b: string | null) => boolean,
	git: GitState,
	dir: string | undefined,
	configured: string[],
): boolean {
	if (spec.startsWith("^")) return false; // a negative refspec only excludes
	const s = spec.replace(/^\+/, "");
	if (s.includes("*") || s === ":" || SHELL_EXPANSION.test(s)) return true;
	const self = (r: string) => (r === "HEAD" || r === "@" ? git.currentBranch(dir) : r);
	const colon = s.indexOf(":");
	if (colon >= 0) return isDefault(self(s.slice(colon + 1)));
	// A source with no destination: the same name, unless remote.<name>.push maps it.
	const src = self(s);
	if (isDefault(src)) return true;
	const mapped = mappedDestinations(configured, src, git.currentBranch(dir));
	return mapped === "any" || mapped.some(isDefault);
}

const SEND_PACK_OPTS_WITH_VALUE = new Set([
	"--receive-pack",
	"--exec",
	"--signed",
	"--push-option",
]);
const SUBTREE_OPTS_WITH_VALUE = new Set([
	"-P",
	"--prefix",
	"-m",
	"--message",
	"--annotate",
	"-b",
	"--branch",
	"--onto",
]);

/** The first word that is not an option or an option's value. */
function firstPositional(args: string[], withValue: Set<string>): string | undefined {
	for (let j = 0; j < args.length; j++) {
		if (withValue.has(args[j])) {
			j++;
			continue;
		}
		if (!args[j].startsWith("-")) return args[j];
	}
	return undefined;
}

/**
 * `git send-pack <remote> [<ref>...]` and `git subtree push <remote> <ref>`.
 * No ref, or anything this check cannot read, fails closed.
 */
function plumbingPushTargetsDefault(
	sub: string,
	args: string[],
	git: GitState,
	dir: string | undefined,
): boolean {
	const withValue = sub === "send-pack" ? SEND_PACK_OPTS_WITH_VALUE : SUBTREE_OPTS_WITH_VALUE;
	const positionals: string[] = [];
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (a === "--all" || a === "--mirror" || a === "--stdin") return true;
		if (withValue.has(a)) {
			j++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positionals.push(a);
	}
	if (sub === "subtree") positionals.shift(); // "push"
	const refs = positionals.slice(1);
	if (refs.length === 0 || positionals.some((p) => SHELL_EXPANSION.test(p))) return true;
	const defaults = new Set(git.defaultBranches(dir).map((b) => b.toLowerCase()));
	const isDefault = (b: string | null) => !!b && defaults.has(branchName(b).toLowerCase());
	// subtree push names only the remote branch to update.
	if (sub === "subtree") return refs.length !== 1 || isDefault(refs[0]) || /[*:]/.test(refs[0]);
	return refs.some((r) => refspecTargetsDefault(r, isDefault, git, dir, []));
}

/** The remote a `git push` with no remote argument uses. */
function pushRemote(git: GitState, current: string | null, dir?: string): string {
	const last = (key: string) => git.config(key, dir).at(-1);
	return (
		(current && last(`branch.${current}.pushRemote`)) ||
		last("remote.pushDefault") ||
		(current && last(`branch.${current}.remote`)) ||
		"origin"
	);
}

/** One remote.<name>.push refspec as source and destination, or "any" when it cannot be bounded. */
function configuredSpec(
	raw: string,
	current: string | null,
): { from: string | null; to: string } | "any" | null {
	const spec = raw.replace(/^\+/, "");
	if (spec.startsWith("^")) return null;
	if (spec.includes("*") || SHELL_EXPANSION.test(spec) || spec === ":") return "any";
	const colon = spec.indexOf(":");
	const from = colon >= 0 ? spec.slice(0, colon) : spec;
	const to = colon >= 0 ? spec.slice(colon + 1) : spec;
	const self = (r: string) => (r === "HEAD" || r === "@" ? current : branchName(r));
	return { from: self(from), to: self(to) ?? "" };
}

/** Destinations remote.<name>.push maps a source branch to. */
function mappedDestinations(
	configured: string[],
	src: string | null,
	current: string | null,
): string[] | "any" {
	const out: string[] = [];
	for (const raw of configured) {
		const spec = configuredSpec(raw, current);
		if (spec === "any") return "any";
		if (spec && src !== null && spec.from?.toLowerCase() === branchName(src).toLowerCase())
			out.push(spec.to);
	}
	return out;
}

/** Where a push with no refspec goes, or "any" when it cannot be bounded. */
function bareDestinations(
	git: GitState,
	current: string | null,
	configured: string[],
	dir?: string,
): string[] | "any" {
	if (configured.length > 0) {
		const out: string[] = [];
		for (const raw of configured) {
			const spec = configuredSpec(raw, current);
			if (spec === "any") return "any";
			if (spec) out.push(spec.to);
		}
		return out;
	}
	const mode = (git.config("push.default", dir).at(-1) ?? "simple").toLowerCase();
	if (mode === "nothing") return [];
	if (mode === "current" || mode === "simple") return current ? [current] : [];
	if (mode === "upstream" || mode === "tracking") {
		if (!current) return [];
		return [git.config(`branch.${current}.merge`, dir).at(-1) ?? current];
	}
	// "matching" pushes every branch that exists on both sides, and an unknown
	// value cannot be bounded.
	return "any";
}

// ── network ───────────────────────────────────────────────────────────────

function nonGetMethod(m: string | undefined): boolean {
	return !!m && !/^(get|head|options)$/i.test(m);
}

/** curl short options that take a value (attached or the next token). */
const CURL_SHORT_WITH_VALUE = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz".split(""));

/** curl long options that send data, run commands on the server or read more options from a file. */
const CURL_SEND_LONG = [
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"--data-ascii",
	"--json",
	"--form",
	"--form-string",
	"--upload-file",
	"--config",
	"--mail-from",
	"--mail-rcpt",
	"--mail-auth",
	"--quote",
];
/** curl protocols that send stdin, mail or server commands rather than fetch a page. */
const CURL_SEND_SCHEME =
	/^(smtps?|ftps?|sftp|scp|telnet|imaps?|pop3s?|ldaps?|tftp|dict|mqtts?|rtsp|gopher|smbs?):\/\//i;

/** A long curl option, exactly or as the unique-prefix abbreviation curl accepts, that sends. */
function curlLongSends(name: string): boolean {
	if (CURL_SEND_LONG.includes(name)) return true;
	// curl accepts a shortened long option; three letters or more, treated as the send option it starts.
	return name.length >= 5 && CURL_SEND_LONG.some((o) => o.startsWith(name));
}

/** The option name of `--name=value`, or the token itself. */
function longName(a: string): string {
	const eq = a.indexOf("=");
	return eq >= 0 ? a.slice(0, eq) : a;
}

function curlUse(args: string[]): "send" | "fetch" {
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (a.startsWith("--")) {
			const name = longName(a);
			if (curlLongSends(name)) return "send";
			if (name.length >= 5 && "--request".startsWith(name)) {
				const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[j + 1];
				if (nonGetMethod(value)) return "send";
				if (!a.includes("=")) j++;
				continue;
			}
		}
		if (CURL_SEND_SCHEME.test(a) || CURL_SEND_SCHEME.test(a.slice(a.indexOf("=") + 1))) {
			return "send";
		}
		if (a.length > 1 && a.startsWith("-") && !a.startsWith("--")) {
			// A short option cluster: flags up to the first that takes a value,
			// which owns the rest of the token, or the next token.
			for (let k = 1; k < a.length; k++) {
				const c = a[k];
				if (c === "d" || c === "F" || c === "T" || c === "K" || c === "Q") return "send";
				if (!CURL_SHORT_WITH_VALUE.has(c)) continue;
				const attached = a.slice(k + 1);
				const value = attached || args[j + 1];
				if (!attached) j++;
				if (c === "X" && nonGetMethod(value)) return "send";
				break;
			}
		}
	}
	return "fetch";
}

function wgetUse(args: string[]): "send" | "fetch" {
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (/^--(post-data|post-file|body-data|body-file)(=|$)/.test(a)) return "send";
		if (a === "--method" && nonGetMethod(args[j + 1])) return "send";
		if (a.startsWith("--method=") && nonGetMethod(a.slice(9))) return "send";
		// -e / --execute sets a wgetrc command; the ones that attach a body or change the method.
		const exec =
			a === "-e" || a === "--execute"
				? args[j + 1]
				: a.startsWith("--execute=")
					? a.slice(10)
					: undefined;
		if (
			exec !== undefined &&
			/^\s*(post_?data|post_?file|body_?data|body_?file|method)\b/i.test(exec)
		) {
			return "send";
		}
	}
	return "fetch";
}

function ghApiUse(rest: string[]): "send" | "fetch" {
	for (let j = 0; j < rest.length; j++) {
		const a = rest[j];
		if (/^--(field|raw-field|input)(=|$)/.test(a)) return "send";
		if (a === "--method" && nonGetMethod(rest[j + 1])) return "send";
		if (a.startsWith("--method=") && nonGetMethod(a.slice(9))) return "send";
		if (a.startsWith("-") && !a.startsWith("--")) {
			// A short cluster such as -iXPOST: flags up to the first that takes a value.
			for (let k = 1; k < a.length; k++) {
				const c = a[k];
				if (c === "f" || c === "F") return "send";
				if (c === "X") {
					const attached = a.slice(k + 1);
					const value = (attached || rest[j + 1] || "").replace(/^=/, "");
					if (nonGetMethod(value)) return "send";
					break;
				}
				if ("HqtpR".includes(c)) {
					if (k === a.length - 1) j++;
					break;
				}
			}
		}
	}
	return "fetch";
}

function ghUse(args: string[]): "send" | "fetch" | null {
	const sub = args[0] ?? "";
	if (sub.startsWith("-")) return null;
	const rest = args.slice(1);
	if (sub === "api") return ghApiUse(rest);
	// The first word that is not an option.
	const action = rest.find((a) => !a.startsWith("-"));
	if (sub === "issue" || sub === "pr") {
		// Anything but a read sends content to the service.
		return action && GH_READ_ONLY.has(action) ? "fetch" : "send";
	}
	if (GH_FETCH_TOP.has(sub)) return "fetch";
	if (GH_GROUPS.has(sub)) {
		if (sub === "auth") return action && GH_GROUP_READ.has(action) ? "fetch" : "send";
		return !action || GH_GROUP_READ.has(action) ? "fetch" : "send";
	}
	return null;
}

/** Tools that open a connection and can send what they are given. */
const SEND_TOOLS = new Set([
	"nc",
	"ncat",
	"netcat",
	"nc.openbsd",
	"nc.traditional",
	"socat",
	"telnet",
	"ssh",
	"scp",
	"sftp",
	"ftp",
	"tftp",
	"lftp",
	"mosh",
	"mosh-client",
	"rcp",
	"rsh",
	"rlogin",
	"pscp",
	"plink",
	"autossh",
	"sshpass",
	"ssh-copy-id",
	"http",
	"https",
	"xh",
	"curlie",
]);
/** Tools that reach the network to look something up or download it. */
const FETCH_TOOLS = new Set([
	"dig",
	"nslookup",
	"ping",
	"ping6",
	"traceroute",
	"whois",
	"nmap",
	"ssh-keyscan",
	"aria2c",
	"axel",
	"lynx",
	"w3m",
]);

/** An rsync operand that names another machine: host:path, user@host:path or rsync://. */
function rsyncRemote(args: string[]): boolean {
	return args.some(
		(a) =>
			/^--(rsh|daemon)(=|$)/.test(a) ||
			/^-[A-Za-z]*e$/.test(a) ||
			a.includes("://") ||
			(!a.startsWith("-") && /^[^/\s:]+:/.test(a)),
	);
}

/** What an interpreter one-liner can do over the network. */
const NETWORK_CODE =
	/socket|connect|\bhttps?\b|:\/\/|\bftp\b|smtp|urllib|urlopen|requests|httpx|aiohttp|\bfetch\b|\bnet\b|dgram|\btls\b|\bssl\b|\bcurl\b|\bwget\b|open-uri|Net::|LWP|WebSocket|XMLHttpRequest|axios|\/dev\/(tcp|udp)|\/inet\w*\/|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|fsockopen|stream_socket|http\.client|ftplib|smtplib|telnetlib|imaplib|poplib|paramiko|xmlrpc/i;

/** Whether an interpreter is given its program on the command line, not in a file. */
function hasInlineProgram(tool: string, args: string[]): boolean {
	if (/^(pypy|python)[\d.]*$/.test(tool)) return args.some((a) => /^-[A-Za-z]*c$/.test(a));
	if (/^(node|nodejs|bun)$/.test(tool))
		return args.some((a) => /^(-e|-p|-pe|--eval|--print)$/.test(a));
	if (tool === "deno") return args[0] === "eval";
	if (tool === "perl" || tool === "ruby") return args.some((a) => /^-[A-Za-z]*e/i.test(a));
	if (tool === "php") return args.includes("-r");
	if (tool === "lua") return args.some((a) => /^-e/.test(a));
	if (/^(pwsh|powershell)$/.test(tool))
		return args.some((a) => /^-(c|command|encodedcommand)$/i.test(a));
	// awk takes its program as the first operand and can open /inet sockets.
	return /^(awk|gawk|mawk|nawk)$/.test(tool);
}

/** A git remote spelled as a URL (or scp-style host:path), not a configured remote name. */
function isUrlRemote(r: string | undefined): boolean {
	if (!r) return false;
	if (/^file:\/\//i.test(r)) return false;
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(r) ||
		/^[\w.-]+@[\w.-]+:/.test(r) ||
		/^[\w-]+(\.[\w-]+)+:/.test(r)
	);
}

/** git subcommands that fetch from the remote they are given. */
const GIT_FETCHING = new Set(["clone", "ls-remote", "fetch", "pull"]);

function gitUse(args: string[]): "send" | "fetch" | null {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		i += GIT_GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1;
	}
	const sub = args[i];
	if (sub !== "push" && !GIT_FETCHING.has(sub ?? "")) return null;
	const rest = args.slice(i + 1);
	if (sub === "push") {
		for (const a of rest) if (a.startsWith("--repo=") && isUrlRemote(a.slice(7))) return "send";
		const remote = firstPositional(rest, PUSH_OPTS_WITH_VALUE);
		return isUrlRemote(remote) ? "send" : null;
	}
	return isUrlRemote(
		firstPositional(rest, new Set(["--depth", "-b", "--branch", "-o", "--origin"])),
	)
		? "fetch"
		: null;
}

/** "send" when this argv sends data, "fetch" when it only reads, null when it is not a network command. */
export function networkUse(argv: string[]): "send" | "fetch" | null {
	const tool = path.basename(argv[0] ?? "");
	const args = argv.slice(1);

	if (tool === "curl") return curlUse(args);
	if (tool === "wget") return wgetUse(args);
	if (tool === "gh") return ghUse(args);
	if (tool === "git") return gitUse(args);
	if (tool === "openssl") return /^s_(client|server|time)$/.test(args[0] ?? "") ? "send" : null;
	if (tool === "rsync") return rsyncRemote(args) ? "send" : null;
	if (SEND_TOOLS.has(tool)) return "send";
	if (FETCH_TOOLS.has(tool)) return "fetch";
	if (hasInlineProgram(tool, args) && NETWORK_CODE.test(args.join(" "))) return "send";
	return null;
}

/**
 * The text the shell opens a path from: quotes and backslash escapes removed,
 * and `$'...'` escapes (\xHH, octal, \uHHHH) decoded.
 */
function shellWords(command: string): string {
	return command
		.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body: string) =>
			body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_e, c: string) => {
				if (/^[xu]/.test(c)) return String.fromCharCode(Number.parseInt(c.slice(1), 16));
				if (/^[0-7]/.test(c)) return String.fromCharCode(Number.parseInt(c, 8));
				return c;
			}),
		)
		.replace(/\\(.)/g, "$1")
		.replace(/["']/g, "");
}

/** A redirect, exec or read of /dev/tcp or /dev/udp, however the path is quoted or escaped. */
export function opensNetworkSocket(command: string): boolean {
	return /\/+dev\/+(tcp|udp)\//i.test(command) || /\/+dev\/+(tcp|udp)\//i.test(shellWords(command));
}

/** An http(s) URL on this machine, with nothing curl would expand. */
const LOOPBACK_URL =
	/^(https?:\/\/)?(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?([/?#][^\s{}[\]]*)?$/i;
/** curl options a loopback fetch may carry. -L is not here: a redirect can leave the machine. */
const CURL_LOOPBACK_SHORT_FLAGS = new Set("sSfiIvkg".split(""));
const CURL_LOOPBACK_SHORT_VALUE = new Set("HmoAw".split(""));
const CURL_LOOPBACK_LONG_FLAGS = new Set([
	"--silent",
	"--show-error",
	"--fail",
	"--fail-with-body",
	"--include",
	"--head",
	"--verbose",
	"--insecure",
	"--compressed",
	"--no-progress-meter",
	"--globoff",
	"--http1.1",
	"--http2",
]);
const CURL_LOOPBACK_LONG_VALUE = new Set([
	"--max-time",
	"--connect-timeout",
	"--output",
	"--header",
	"--user-agent",
	"--write-out",
	"--retry",
	"--retry-delay",
	"--retry-max-time",
	"--url",
]);

/**
 * A curl fetch whose every target is loopback, carrying only options known not
 * to send data or leave the machine (no proxy, resolve override, config file
 * or redirect following).
 */
export function isLoopbackOnlyFetch(argv: string[]): boolean {
	if (path.basename(argv[0] ?? "") !== "curl" || networkUse(argv) !== "fetch") return false;
	let targets = 0;
	const args = argv.slice(1);
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		let url: string | undefined;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq >= 0 ? a.slice(0, eq) : a;
			if (eq < 0 && CURL_LOOPBACK_LONG_FLAGS.has(name)) continue;
			if (!CURL_LOOPBACK_LONG_VALUE.has(name)) return false;
			const value = eq >= 0 ? a.slice(eq + 1) : args[++j];
			if (value === undefined) return false;
			if (name !== "--url") continue;
			url = value;
		} else if (a.length > 1 && a.startsWith("-")) {
			for (let k = 1; k < a.length; k++) {
				const c = a[k];
				if (CURL_LOOPBACK_SHORT_FLAGS.has(c)) continue;
				if (!CURL_LOOPBACK_SHORT_VALUE.has(c)) return false;
				if (k === a.length - 1) j++;
				break;
			}
			continue;
		} else {
			url = a;
		}
		if (!LOOPBACK_URL.test(url)) return false;
		targets++;
	}
	return targets > 0;
}

// ── the decision ──────────────────────────────────────────────────────────

const PUSH_REASON = "it can push to the default branch";

/** Environment that changes which repository or git configuration git reads. */
const GIT_ENV_ASSIGNMENT = /^(GIT_\w+|HOME|XDG_CONFIG_HOME)=/;

/** What earlier segments of one command line did to the state git will see. */
interface LineState {
	/** Directory after any `cd`, relative to the git state's base. */
	dir?: string;
	/** An earlier segment made the repository or its configuration unknowable. */
	unknownRepo: boolean;
}

/** Whether this git argv writes configuration a later push or alias would read. */
function writesGitConfig(argv: string[]): boolean {
	if (path.basename(argv[0] ?? "") !== "git") return false;
	let i = 1;
	while (i < argv.length && argv[i].startsWith("-"))
		i += GIT_GLOBAL_WITH_VALUE.has(argv[i]) ? 2 : 1;
	const sub = argv[i];
	const rest = argv.slice(i + 1);
	if (sub === "config") {
		const reads = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)$/;
		return !rest.some((a) => reads.test(a));
	}
	if (sub === "remote") return rest.length > 0 && !/^(-v|--verbose|show|get-url)$/.test(rest[0]);
	if (sub === "branch" || sub === "checkout" || sub === "switch" || sub === "worktree") {
		return rest.some((a) => /^(-u|-t|--track|--set-upstream-to|--set-upstream)(=|$)/.test(a));
	}
	return false;
}

/** Why one command (a single segment's words) must be approved, or null. */
function argvReason(
	raw: string[],
	ctx: CommandPolicyContext,
	depth: number,
	line: LineState,
	appendsArgs = false,
): string | null {
	const unwrapped = stripPrefix(raw);
	if (!unwrapped) return "it runs a command through a wrapper whose options this check cannot read";
	const argv = unwrapped.argv;
	if (argv.length === 0) return null;
	const moreArgs = appendsArgs || unwrapped.appendsArgs;

	// Prefixes that point git at another repository or configuration, or run it
	// as another user, make the repository state unknowable from here.
	const prefix = raw.slice(0, raw.length - argv.length);
	const unknownRepo =
		line.unknownRepo ||
		prefix.some(
			(t, k) =>
				GIT_ENV_ASSIGNMENT.test(t) ||
				path.basename(t) === "sudo" ||
				(path.basename(t) === "env" && (prefix[k + 1] ?? "").startsWith("-")),
		);
	if (
		pushTargetsDefaultBranch(argv, ctx.git, { appendsArgs: moreArgs, dir: line.dir, unknownRepo })
	) {
		return PUSH_REASON;
	}

	const use = networkUse(argv);
	// Arguments the line does not show could carry a request body.
	if (use === "send" || (use !== null && moreArgs)) return "it sends data over the network";
	if (use === "fetch" && ctx.pinnedLocalProvider && !isLoopbackOnlyFetch(argv)) {
		return "it reaches the network while a local provider is pinned";
	}

	if (depth < 3) {
		for (const payload of findPayloads(argv)) {
			if (payload.length === 0) continue;
			const inner = argvReason(payload, ctx, depth + 1, line, moreArgs || payload.includes("{}"));
			if (inner) return inner;
		}
	}
	return null;
}

/**
 * Commands that can change the shell's directory without a visible plain
 * `cd`. `builtin cd` and `command cd` are caught by the cd word itself.
 */
const MAY_CHANGE_DIR = new Set(["eval", "source", ".", "pushd", "popd"]);
/** A word that, inside a quoted or compound command, changes directory. */
const CD_WORD = /(^|[\s;&|({`])(cd|pushd|popd)(\s|$|[;&|)}])/;

/**
 * The directory a plain `cd <literal path>` moves to, or null when the
 * segment is not one (options, more words, expansions, CDPATH lookups).
 */
function plainCdTarget(raw: string[], dir: string | undefined): string | null {
	if (raw[0] !== "cd" || raw.length > 2) return null;
	const to = raw[1];
	if (to === undefined) return os.homedir();
	if (to.startsWith("-") || SHELL_EXPANSION.test(to)) return null;
	const explicit = /^(\/|\.\/|\.\.\/|\.$|\.\.$|~)/.test(to);
	// A bare relative name is looked up through CDPATH when one is set.
	if (!explicit && process.env.CDPATH) return null;
	const target = to.startsWith("~") ? path.join(os.homedir(), to.slice(1)) : to;
	return path.isAbsolute(target) ? target : path.join(dir ?? ".", target);
}

/** Carry what this segment does to the state later segments' git commands see. */
function advanceLine(line: LineState, raw: string[]): void {
	const first = raw[0] ?? "";
	if (raw.some((t) => /CDPATH/.test(t))) {
		line.unknownRepo = true;
		return;
	}
	if (first === "cd") {
		const target = plainCdTarget(raw, line.dir);
		if (target === null) line.unknownRepo = true;
		else line.dir = target;
		return;
	}
	// Anything else that could move the shell: the repository is unknown from here.
	if (
		MAY_CHANGE_DIR.has(first) ||
		/^[({]/.test(first) ||
		raw.some((t) => t === "cd" || t === "pushd" || t === "popd" || CD_WORD.test(t))
	) {
		line.unknownRepo = true;
		return;
	}
	// export / plain assignments of git's environment reach later commands.
	if (
		raw.every(
			(t) => /^[A-Za-z_]\w*=/.test(t) || t === "export" || t === "unset" || t.startsWith("-"),
		)
	) {
		if (raw.some((t) => GIT_ENV_ASSIGNMENT.test(t) || /^(GIT_\w+|HOME|XDG_CONFIG_HOME)$/.test(t))) {
			line.unknownRepo = true;
		}
		return;
	}
	if (
		raw.some(
			(t) =>
				/^(export|unset)$/.test(t) &&
				raw.some((u) => /^(GIT_\w+|HOME|XDG_CONFIG_HOME)(=|$)/.test(u)),
		)
	) {
		line.unknownRepo = true;
	}
	const unwrapped = stripPrefix(raw);
	if (!unwrapped || writesGitConfig(unwrapped.argv)) line.unknownRepo = true;
	// Writing a git config file directly.
	if (raw.some((t) => /(^|\/)\.git\/config$|(^|\/)\.gitconfig$|(^|\/)git\/config$/.test(t))) {
		line.unknownRepo = true;
	}
}

/**
 * Why a person must approve this command, or null when the usual rules apply.
 * Plain words: the reason is shown in the prompt and in a refusal.
 */
export function mustAskReason(
	command: string,
	ctx: CommandPolicyContext,
	depth = 0,
	line: LineState = { unknownRepo: false },
): string | null {
	if (opensNetworkSocket(command)) return "it redirects data to a network socket";

	for (const segment of commandSegments(command)) {
		const raw = tokenize(segment);
		// A quoted inner command (sh -c "...") is a command line of its own.
		if (depth < 3) {
			for (const t of raw) {
				if (/\s/.test(t)) {
					const inner = mustAskReason(t, ctx, depth + 1, { ...line });
					if (inner) return inner;
				}
			}
		}
		const reason = argvReason(raw, ctx, depth, line);
		if (reason) return reason;
		advanceLine(line, raw);
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

/**
 * Run a read-only git command. Returns its output, or null for the exit codes
 * in `absent` (an unset key, a detached HEAD); throws GitStateUnreadable for any
 * other failure, including a timeout.
 */
function git(dir: string, args: string[], absent: number[] = []): string | null {
	let r: ReturnType<typeof spawnSync>;
	try {
		r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 2000 });
	} catch {
		throw new GitStateUnreadable(args.join(" "));
	}
	if (r.status === 0) return String(r.stdout).trim();
	if (r.status !== null && absent.includes(r.status)) return null;
	throw new GitStateUnreadable(args.join(" "));
}

const _commandDir = new AsyncLocalStorage<string>();

/** The working directory of the command being checked, when a caller bound one. */
export function commandDir(): string | undefined {
	return _commandDir.getStore();
}

/**
 * Check (and run) a command as running in `dir`: the git state is read from
 * there, not from the process directory. Each tool binds its own working
 * directory, so a tab or worktree is judged against its own repository.
 */
export function withCommandDir<T>(dir: string, fn: () => T): T {
	return _commandDir.run(dir, fn);
}

/**
 * Git state read from the repository: the current branch, main, master and
 * origin's HEAD as the default branches, config values and aliases. Read
 * fresh on every call, never cached across commands: a config or alias change
 * followed by a push must be judged against the state the push will see.
 * The base directory is the bound command directory, else the workspace root,
 * else the process directory.
 */
export function repoGitState(
	baseDir: () => string = () => commandDir() || process.env.EIGHT_WORKSPACE_ROOT || process.cwd(),
): GitState {
	const resolve = (dir?: string) => path.resolve(baseDir(), dir ?? ".");
	return {
		// Exit 1 from symbolic-ref is a detached HEAD; anything else is unreadable.
		currentBranch: (dir) =>
			git(resolve(dir), ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]) || null,
		defaultBranches: (dir) => {
			let originHead: string | null = null;
			try {
				originHead = git(
					resolve(dir),
					["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
					[1],
				);
			} catch {
				// main and master still count; the reads that decide the push fail closed.
			}
			const defaults = ["main", "master"];
			if (originHead) defaults.push(originHead.replace(/^origin\//, ""));
			return defaults;
		},
		config: (key, dir) => {
			// Exit 1: the key is not set.
			const out = git(resolve(dir), ["config", "--get-all", key], [1]);
			return out ? out.split("\n") : [];
		},
		aliases: (dir) => {
			// Exit 1: no aliases.
			const out = git(resolve(dir), ["config", "--get-regexp", "^alias\\."], [1]);
			const aliases: Record<string, string> = {};
			for (const line of out ? out.split("\n") : []) {
				const m = /^alias\.(\S+)\s?(.*)$/.exec(line);
				if (m) aliases[m[1].toLowerCase()] = m[2];
			}
			return aliases;
		},
	};
}

/** Providers that run on the user's machine. */
export const LOCAL_PROVIDERS = new Set([
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apfel",
	"apple-foundation",
]);

/** EIGHT_PROVIDERS_ALLOW names only local providers: a pinned local setup by config. */
export function allowListIsLocalOnly(value: string | undefined): boolean {
	const list = (value ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return list.length > 0 && list.every((p) => LOCAL_PROVIDERS.has(p));
}
