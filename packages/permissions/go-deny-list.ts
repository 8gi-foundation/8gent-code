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
const SHELL_TOOLS = new Set<string>([
	"bash",
	"shell",
	"run_command",
	"exec",
	"system",
]);

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
	const rmRecursive = /\brm\s+(?:-[A-Za-z]*[rR][A-Za-z]*[fF][A-Za-z]*|-[A-Za-z]*[fF][A-Za-z]*[rR][A-Za-z]*|-rf|-fr|-Rf|-fR|--recursive\s+--force|--force\s+--recursive)\b/;
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

/**
 * Pattern: git push to main or master (with or without --force).
 */
function matchGitPushProtectedBranch(args: string): boolean {
	if (!/\bgit\s+push\b/.test(args)) return false;
	// Match "git push <remote> main" or "git push origin master" or "git push origin HEAD:main"
	return /\bgit\s+push\s+\S+\s+([^\s:]+:)?(?:main|master)\b/.test(args);
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
