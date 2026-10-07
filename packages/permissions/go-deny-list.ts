/**
 * 8gent Code - /goal Hard Deny-List (issue #2609, epic #2605)
 *
 * Hardcoded patterns that can NEVER be overridden by /goal context, /subgoal
 * payloads, YAML policy, or runtime addPolicy calls. The deny-list is the
 * last line of defence: if a tool call matches, the run is killed.
 *
 * Owner: 8SO. Edits require a security review checkpoint.
 */

export interface DenyListPattern {
	/** Stable id for audit logs */
	id: string;
	/** Human-readable label for the matched class */
	label: string;
	/** Matcher: receives tool name + serialised args, returns true on hit */
	match: (tool: string, args: string) => boolean;
}

export interface DenyListResult {
	denied: boolean;
	pattern?: string;
	label?: string;
}

/**
 * Treat any tool that runs shell/commands as a shell call. The /goal gate
 * itself never inspects file content - only tool invocation metadata.
 */
const SHELL_TOOLS = new Set<string>(["bash", "shell", "run_command", "exec", "system"]);

const isShell = (tool: string): boolean => SHELL_TOOLS.has(tool.toLowerCase());

/**
 * Financial / banking / payment domain blocklist. Pure string match against
 * the serialised args - no SDK imports, no URL parsing, no allow-listing.
 * If the tool call mentions any of these substrings, it is denied.
 */
const FINANCIAL_DOMAIN_SUBSTRINGS: string[] = [
	"stripe.com",
	"api.stripe.com",
	"dashboard.stripe.com",
	"polar.sh",
	"api.polar.sh",
	"paypal.com",
	"api.paypal.com",
	"plaid.com",
	"api.plaid.com",
	"revolut.com",
	"wise.com",
	"transferwise.com",
	"chase.com",
	"bankofamerica.com",
	"wellsfargo.com",
	"hsbc.com",
	"barclays.com",
	"aib.ie",
	"bankofireland.com",
	"coinbase.com",
	"binance.com",
	"kraken.com",
];

/**
 * Key/credential export commands. Match common shell patterns used to
 * exfiltrate secrets. Substring match against the serialised args.
 */
const KEY_EXPORT_PATTERNS: RegExp[] = [
	// Generic export of secret-shaped env vars
	/\bexport\s+[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD|PASS|API|CREDENTIAL|PRIVATE)[A-Z0-9_]*\s*=/i,
	// Reading common credential files
	/\bcat\s+[^\s]*(\.env|id_rsa|id_ed25519|\.ssh\/[^\s]+|\.aws\/credentials|\.npmrc|\.netrc)/i,
	// gpg / openssl export
	/\bgpg\s+--export-secret-keys?\b/i,
	/\bopenssl\s+(rsa|pkcs8|pkcs12)[^|;\n]*-out\b/i,
	// security tool (macOS keychain dump)
	/\bsecurity\s+(dump-keychain|find-(generic|internet)-password)/i,
	// printenv / env dump
	/\b(printenv|env)\b\s*(\||>|\|\s*curl|\|\s*nc)/i,
	// scp / curl uploading credential files
	/\b(scp|rsync|curl|wget)\s+[^\n]*(\.env|\.ssh|id_rsa|credentials)/i,
	// aws iam create-access-key (key export)
	/\baws\s+iam\s+create-access-key\b/i,
];

/**
 * DNS / MX record mutation commands. Catches CLIs that can alter resolver
 * state or update authoritative records.
 */
const DNS_MUTATION_PATTERNS: RegExp[] = [
	// macOS network service configuration
	/\bnetworksetup\s+-set(dnsservers|searchdomains)\b/i,
	// resolvectl / systemd-resolved (Linux)
	/\bresolvectl\s+(dns|domain|reset|flush-caches)\b/i,
	/\bsystemd-resolve\s+--(set-dns|set-domain|reset-server-features)\b/i,
	// nmcli (NetworkManager)
	/\bnmcli\s+[^\n]*\bipv[46]\.dns\b/i,
	// Direct edits to resolver files
	/\b(>|>>)\s*\/etc\/resolv\.conf\b/,
	/\btee\s+(-a\s+)?\/etc\/resolv\.conf\b/,
	// Registrar / DNS provider CLIs - any record write
	/\b(cloudflare|cf)\s+[^\n]*\b(dns|record)\b[^\n]*\b(create|update|set|delete|edit)\b/i,
	/\baws\s+route53\s+(change-resource-record-sets|create-hosted-zone|delete-hosted-zone)\b/i,
	/\bgcloud\s+dns\s+(record-sets|managed-zones)\s+(create|update|delete)\b/i,
	/\baz\s+network\s+dns\s+record-set\s+[a-z]+\s+(create|update|delete|add-record|remove-record)\b/i,
	/\bdoctl\s+compute\s+domain\s+(create|delete|records)\b/i,
	/\bnamecheap\b[^\n]*\b(setHosts|dns)\b/i,
	// MX-specific writes
	/\bmx\s+record\b[^\n]*\b(set|update|create|delete)\b/i,
];

/**
 * Pattern: rm -rf outside /tmp. Detects -rf / -fr / -Rf flag combos.
 * Allows paths under /tmp or the OS temp dir; everything else is denied.
 */
function matchRmRfOutsideTmp(args: string): boolean {
	// Look for rm with recursive + force flags
	const rmRecursive =
		/\brm\s+(?:-[A-Za-z]*[rR][A-Za-z]*[fF][A-Za-z]*|-[A-Za-z]*[fF][A-Za-z]*[rR][A-Za-z]*|-rf|-fr|-Rf|-fR|--recursive\s+--force|--force\s+--recursive)\b/;
	if (!rmRecursive.test(args)) return false;

	// Extract the path tokens after the flags. Anything that looks like a
	// non-tmp absolute path or a non-tmp relative path = deny.
	// Conservative: split on whitespace, look at every non-flag token.
	const tokens = args.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
	// The first token is usually "rm" itself; iterate the rest.
	const targets = tokens.slice(tokens.findIndex((t) => t === "rm" || t.endsWith("/rm")) + 1);

	if (targets.length === 0) {
		// rm -rf with no target - denied (could be lurking arg expansion)
		return true;
	}

	for (const t of targets) {
		const normalised = t.replace(/^["']|["']$/g, "");
		// Allowed: /tmp/*, $TMPDIR, ./tmp, anything inside /private/tmp (macOS)
		if (
			normalised.startsWith("/tmp/") ||
			normalised === "/tmp" ||
			normalised.startsWith("/private/tmp/") ||
			normalised === "/private/tmp" ||
			normalised.startsWith("$TMPDIR") ||
			normalised.startsWith("${TMPDIR}")
		) {
			continue;
		}
		// Anything else triggers deny
		return true;
	}
	return false;
}

/**
 * Pattern: git push --force / --force-with-lease (any branch).
 */
function matchGitPushForce(args: string): boolean {
	return /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/.test(args);
}

/** Branches a push may never land on without a person approving it. */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/** git options that take the next token as their value. */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_PUSH_OPTS_WITH_VALUE = new Set([
	"-o",
	"--push-option",
	"--repo",
	"--receive-pack",
	"--exec",
]);
/** Flags that push every local branch, protected ones included. */
const GIT_PUSH_ALL_REFS = new Set(["--all", "--mirror", "--branches"]);

function unquote(token: string): string {
	return token.replace(/^["'(]+|["');]+$/g, "");
}

/** Destination branch of a refspec: `src:dst`, `+dst`, `refs/heads/dst`. */
function refspecTargetsProtected(spec: string): boolean {
	const dst = (spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec)
		.replace(/^\+/, "")
		.replace(/^refs\/heads\//, "")
		.toLowerCase();
	return PROTECTED_BRANCHES.includes(dst);
}

/** True when one shell segment is a `git push` that names a protected branch. */
function segmentPushesProtected(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).map(unquote).filter(Boolean);
	const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
	if (gitIdx < 0) return false;
	let i = gitIdx + 1;
	while (i < tokens.length && tokens[i].startsWith("-")) {
		if (GIT_GLOBAL_OPTS_WITH_VALUE.has(tokens[i])) i++;
		i++;
	}
	if (tokens[i] !== "push") return false;

	const positional: string[] = [];
	let repoGiven = false;
	for (let j = i + 1; j < tokens.length; j++) {
		const t = tokens[j];
		if (GIT_PUSH_ALL_REFS.has(t)) return true;
		if (t === "--repo" || t.startsWith("--repo=")) repoGiven = true;
		if (GIT_PUSH_OPTS_WITH_VALUE.has(t)) {
			j++;
			continue;
		}
		if (t.startsWith("-")) continue;
		positional.push(t);
	}
	// First positional is the remote unless --repo named it.
	const refspecs = repoGiven ? positional : positional.slice(1);
	return refspecs.some(refspecTargetsProtected);
}

/**
 * Pattern: git push to a protected branch (with or without --force).
 * Covers `git push <remote> main`, `HEAD:main`, `refs/heads/main`, `+main`,
 * `:main`, master, `-u`, `git -C dir push`, chained commands, and `--all` /
 * `--mirror` (which push every branch). A bare `git push` with no refspec
 * cannot be resolved without the repo state and is not matched here.
 */
export function matchGitPushProtectedBranch(args: string): boolean {
	if (!/\bpush\b/.test(args)) return false;
	return args.split(/&&|\|\||[;|&\n]|\$\(|`/).some(segmentPushesProtected);
}

/**
 * Pattern: gh pr merge --admin (admin merge bypasses review).
 */
function matchGhPrMergeAdmin(args: string): boolean {
	return /\bgh\s+pr\s+merge\b[^\n]*--admin\b/.test(args);
}

/**
 * Pattern: financial / banking / payment domains in args.
 */
function matchFinancialDomain(args: string): boolean {
	const lower = args.toLowerCase();
	return FINANCIAL_DOMAIN_SUBSTRINGS.some((d) => lower.includes(d));
}

/**
 * Pattern: macOS `defaults write` (persistent system preference mutation).
 */
function matchDefaultsWrite(args: string): boolean {
	return /\bdefaults\s+write\b/.test(args);
}

/**
 * Pattern: sudo invocation, anywhere in the command (including via env or
 * pipeline). We deny on any literal "sudo " token.
 */
function matchSudo(args: string): boolean {
	return /(^|[\s;&|`(])sudo\s+/.test(args);
}

/**
 * Pattern: DNS / MX record mutation commands.
 */
function matchDnsMxMutation(args: string): boolean {
	return DNS_MUTATION_PATTERNS.some((re) => re.test(args));
}

/**
 * Pattern: credential export commands.
 */
function matchCredentialExport(args: string): boolean {
	return KEY_EXPORT_PATTERNS.some((re) => re.test(args));
}

/**
 * Pattern: npm publish (any package, any registry).
 */
function matchNpmPublish(args: string): boolean {
	return /\b(npm|pnpm|yarn|bun)\s+publish\b/.test(args);
}

/**
 * Pattern: fly deploy --prod / fly deploy to production app.
 */
function matchFlyDeployProd(args: string): boolean {
	if (!/\bfly(ctl)?\s+deploy\b/.test(args)) return false;
	return /--prod\b|--app\s+\S*prod\S*|--app\s+\S*production\S*/.test(args);
}

/**
 * The deny-list itself. Order is informational; matching short-circuits on
 * the first hit so the most specific patterns come first.
 */
export const GO_DENY_LIST: DenyListPattern[] = [
	{
		id: "rm-rf-outside-tmp",
		label: "rm -rf outside /tmp",
		match: (tool, args) => isShell(tool) && matchRmRfOutsideTmp(args),
	},
	{
		id: "git-push-force",
		label: "git push --force",
		match: (tool, args) => isShell(tool) && matchGitPushForce(args),
	},
	{
		id: "git-push-protected-branch",
		label: "git push to main/master",
		match: (tool, args) => isShell(tool) && matchGitPushProtectedBranch(args),
	},
	{
		id: "gh-pr-merge-admin",
		label: "gh pr merge --admin",
		match: (tool, args) => isShell(tool) && matchGhPrMergeAdmin(args),
	},
	{
		id: "financial-domain",
		label: "financial / banking / payment domain",
		// Financial domains are denied for ANY tool (network_request, fetch,
		// curl in shell, etc) - the substring match catches them all.
		match: (_tool, args) => matchFinancialDomain(args),
	},
	{
		id: "defaults-write",
		label: "macOS defaults write",
		match: (tool, args) => isShell(tool) && matchDefaultsWrite(args),
	},
	{
		id: "sudo",
		label: "sudo invocation",
		match: (tool, args) => isShell(tool) && matchSudo(args),
	},
	{
		id: "dns-mx-mutation",
		label: "DNS / MX record mutation",
		match: (tool, args) => isShell(tool) && matchDnsMxMutation(args),
	},
	{
		id: "credential-export",
		label: "credential / key export",
		match: (tool, args) => isShell(tool) && matchCredentialExport(args),
	},
	{
		id: "npm-publish",
		label: "npm publish",
		match: (tool, args) => isShell(tool) && matchNpmPublish(args),
	},
	{
		id: "fly-deploy-prod",
		label: "fly deploy --prod",
		match: (tool, args) => isShell(tool) && matchFlyDeployProd(args),
	},
];

// ============================================
// Never-auto set (issue #2699, 8GO rule 2 / 8SO maker-checker)
// ============================================

/**
 * The set of action classes that may NEVER auto-fire (cap at rung 3, always
 * a human second signature) regardless of the configured autonomy rung. This
 * is the decision-level analogue of GO_DENY_LIST: GO_DENY_LIST blocks tool
 * calls outright; NEVER_AUTO_CLASSES caps the autonomy of otherwise-permitted
 * actions. The autonomy ladder's irreversible/under-James's-name capping
 * enforces this; this list is the named, auditable source of truth.
 */
export const NEVER_AUTO_CLASSES: { id: string; label: string }[] = [
	{
		id: "irreversible",
		label: "irreversible action (delete, force-push, history rewrite, prod deploy, DB drop)",
	},
	{ id: "under-james-name", label: "outbound under James's name (original opinion / public post)" },
	{ id: "non-retractable-send", label: "non-retractable external send" },
	{ id: "spend-over-envelope", label: "spend above the budget envelope" },
	{ id: "model-promotion-minor-plus", label: "model promotion of minor or major version" },
	{ id: "maker-equals-checker", label: "maker is its own checker (no independent verdict)" },
];

export interface NeverAutoContext {
	/** Whether the action is reversible (Undo / revert / retract / checkpoint). */
	reversible?: boolean;
	/** Whether the action speaks to the world under James's name. */
	underJamesName?: boolean;
	/** Maker identity. */
	maker?: string;
	/** Checker identity. MUST differ from maker for an action to auto. */
	checker?: string;
}

export interface NeverAutoResult {
	neverAuto: boolean;
	/** Matched class ids (may be more than one). */
	classes: string[];
}

/**
 * Decide whether an action may NEVER auto-fire. Returns the matched class
 * ids. An action with ANY match caps at rung 3 (human second signature) and
 * is never eligible for rung 4 auto, regardless of dial setting.
 */
export function matchNeverAuto(ctx: NeverAutoContext): NeverAutoResult {
	const classes: string[] = [];
	if (ctx.reversible === false) classes.push("irreversible");
	if (ctx.underJamesName === true) classes.push("under-james-name");
	// maker == checker (or a missing checker) means no independent verdict.
	if (!ctx.maker || !ctx.checker || ctx.maker === ctx.checker) {
		classes.push("maker-equals-checker");
	}
	return { neverAuto: classes.length > 0, classes };
}

/**
 * Serialise tool args to a single string for substring/regex matching.
 * Handles strings, arrays, and objects.
 */
function serialiseArgs(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args === "string") return args;
	if (Array.isArray(args)) {
		return args.map(serialiseArgs).join(" ");
	}
	if (typeof args === "object") {
		try {
			// Stringify with spaces so substrings stay matchable across keys
			return Object.values(args as Record<string, unknown>)
				.map(serialiseArgs)
				.join(" ");
		} catch {
			return "";
		}
	}
	return String(args);
}

export interface ToolCallLike {
	name: string;
	args: unknown;
}

/**
 * Match a tool call against the deny-list. Returns the first matching
 * pattern, or { denied: false } if nothing matched.
 *
 * The deny-list is hardcoded - this function MUST NOT accept overrides,
 * extensions, or context-based skips. /goal runs that need an exception must
 * fail loudly and route through human-in-the-loop approval, not bypass.
 */
export function matchDenyList(toolCall: ToolCallLike): DenyListResult {
	const args = serialiseArgs(toolCall.args);
	for (const pattern of GO_DENY_LIST) {
		if (pattern.match(toolCall.name, args)) {
			return { denied: true, pattern: pattern.id, label: pattern.label };
		}
	}
	return { denied: false };
}
