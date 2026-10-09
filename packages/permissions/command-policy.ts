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
 *   variables, configuration set on the command line or in the environment);
 * - a network command that sends data: a request body, a form or file upload,
 *   a non-GET method, a write through `gh issue` / `gh pr`, or output
 *   redirected to a network socket;
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
 * Infinite mode does not apply these checks; decision pending. Its fast path
 * in PermissionManager (requestPermission and checkPermission) returns before
 * isDangerous, so only the always-blocked set applies there. A test pins this
 * so that changing it is a deliberate decision, not a side effect.
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

const GH_NETWORK = new Set(["api", "issue", "pr"]);
const GH_READ_ONLY = new Set(["list", "view", "status", "checks", "diff", "checkout"]);

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
	depth?: number;
}

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
	const depth = opts.depth ?? 0;
	if (path.basename(argv[0] ?? "") !== "git") return false;
	if (depth > 5) return true;
	let i = 1;
	let dir: string | undefined;
	let routedByCommandLine = false;
	while (i < argv.length && argv[i].startsWith("-")) {
		const a = argv[i];
		if (a === "-C") dir = argv[i + 1];
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

	if (sub !== "push") {
		const aliases = git.aliases(dir);
		const expansion = aliases[sub.toLowerCase()];
		if (expansion === undefined) return false;
		if (expansion.trimStart().startsWith("!")) {
			// A shell alias: fail closed when it can reach push at all.
			return pushCapableAliases(aliases).has(sub.toLowerCase());
		}
		const expanded = [...argv.slice(0, i), ...tokenize(expansion), ...argv.slice(i + 1)];
		return pushTargetsDefaultBranch(expanded, git, { ...opts, depth: depth + 1 });
	}

	if (routedByCommandLine || opts.appendsArgs) return true;

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

	return refspecs.some((spec) => {
		if (spec.startsWith("^")) return false; // a negative refspec only excludes
		const s = spec.replace(/^\+/, "");
		if (s.includes("*") || s === ":") return true;
		const colon = s.indexOf(":");
		if (colon >= 0) {
			const dst = s.slice(colon + 1);
			if (dst === "HEAD" || dst === "@") return isDefault(current);
			return isDefault(dst);
		}
		// A source with no destination: the same name, unless remote.<name>.push maps it.
		const src = s === "HEAD" || s === "@" ? current : s;
		if (isDefault(src)) return true;
		const mapped = mappedDestinations(configured, src, current);
		return mapped === "any" || mapped.some(isDefault);
	});
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

/** "send" when this argv sends data, "fetch" when it only reads, null when it is not a network command. */
export function networkUse(argv: string[]): "send" | "fetch" | null {
	const tool = path.basename(argv[0] ?? "");
	const args = argv.slice(1);

	if (tool === "curl") {
		for (let j = 0; j < args.length; j++) {
			const a = args[j];
			if (
				/^--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string|upload-file)(=|$)/.test(
					a,
				)
			) {
				return "send";
			}
			if (a === "--request") {
				if (nonGetMethod(args[j + 1])) return "send";
				j++;
				continue;
			}
			if (a.startsWith("--request=") && nonGetMethod(a.slice(10))) return "send";
			if (a.length > 1 && a.startsWith("-") && !a.startsWith("--")) {
				// A short option cluster: flags up to the first that takes a value,
				// which owns the rest of the token, or the next token.
				for (let k = 1; k < a.length; k++) {
					const c = a[k];
					if (c === "d" || c === "F" || c === "T") return "send";
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
const GIT_CONFIG_ENV = /\bGIT_CONFIG\w*=/;

/** Why one command (a single segment's words) must be approved, or null. */
function argvReason(
	raw: string[],
	ctx: CommandPolicyContext,
	depth: number,
	appendsArgs = false,
): string | null {
	const unwrapped = stripPrefix(raw);
	if (!unwrapped) return "it runs a command through a wrapper whose options this check cannot read";
	const argv = unwrapped.argv;
	if (argv.length === 0) return null;
	const moreArgs = appendsArgs || unwrapped.appendsArgs;

	// Git configuration from the environment can reroute a push or define an alias.
	if (path.basename(argv[0]) === "git" && raw.some((t) => GIT_CONFIG_ENV.test(t)))
		return PUSH_REASON;
	if (pushTargetsDefaultBranch(argv, ctx.git, { appendsArgs: moreArgs })) return PUSH_REASON;

	const use = networkUse(argv);
	// Arguments the line does not show could carry a request body.
	if (use === "send" || (use !== null && moreArgs)) return "it sends data over the network";
	if (use === "fetch" && ctx.pinnedLocalProvider && !isLoopbackOnlyFetch(argv)) {
		return "it reaches the network while a local provider is pinned";
	}

	if (depth < 3) {
		for (const payload of findPayloads(argv)) {
			if (payload.length === 0) continue;
			const inner = argvReason(payload, ctx, depth + 1, moreArgs || payload.includes("{}"));
			if (inner) return inner;
		}
	}
	return null;
}

/**
 * Why a person must approve this command, or null when the usual rules apply.
 * Plain words: the reason is shown in the prompt and in a refusal.
 */
export function mustAskReason(
	command: string,
	ctx: CommandPolicyContext,
	depth = 0,
): string | null {
	if (/\/dev\/(tcp|udp)\//i.test(command)) return "it redirects data to a network socket";
	// GIT_CONFIG_* exported earlier on the line reaches a later git command.
	if (GIT_CONFIG_ENV.test(command) && /\bgit\b/.test(command.replace(/\bGIT_CONFIG\w*=\S*/g, ""))) {
		return PUSH_REASON;
	}

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
		const reason = argvReason(raw, ctx, depth);
		if (reason) return reason;
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

const CACHE_MS = 5000;

/**
 * Git state read from the repository: the current branch, main, master and
 * origin's HEAD as the default branches, config values and aliases. Cached per
 * directory for a few seconds, since one command is checked several times.
 */
export function repoGitState(
	baseDir: () => string = () => process.env.EIGHT_WORKSPACE_ROOT || process.cwd(),
): GitState {
	const cache = new Map<string, { at: number; value: unknown }>();
	const cached = <T>(key: string, load: () => T): T => {
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
		const value = load();
		cache.set(key, { at: Date.now(), value });
		return value;
	};
	const resolve = (dir?: string) => path.resolve(baseDir(), dir ?? ".");
	return {
		currentBranch: (dir) => {
			const d = resolve(dir);
			return cached(`branch\0${d}`, () => {
				const current = git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
				return current && current !== "HEAD" ? current : null;
			});
		},
		defaultBranches: (dir) => {
			const d = resolve(dir);
			return cached(`defaults\0${d}`, () => {
				const originHead = git(d, [
					"symbolic-ref",
					"--quiet",
					"--short",
					"refs/remotes/origin/HEAD",
				]);
				const defaults = ["main", "master"];
				if (originHead) defaults.push(originHead.replace(/^origin\//, ""));
				return defaults;
			});
		},
		config: (key, dir) => {
			const d = resolve(dir);
			return cached(`config\0${d}\0${key}`, () => {
				const out = git(d, ["config", "--get-all", key]);
				return out ? out.split("\n") : [];
			});
		},
		aliases: (dir) => {
			const d = resolve(dir);
			return cached(`aliases\0${d}`, () => {
				const out = git(d, ["config", "--get-regexp", "^alias\\."]);
				const aliases: Record<string, string> = {};
				for (const line of out ? out.split("\n") : []) {
					const m = /^alias\.(\S+)\s?(.*)$/.exec(line);
					if (m) aliases[m[1].toLowerCase()] = m[2];
				}
				return aliases;
			});
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
