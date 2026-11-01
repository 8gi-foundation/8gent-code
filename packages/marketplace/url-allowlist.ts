/**
 * 8gent App Marketplace - Archive URL allowlist
 *
 * Single decision point for whether an archive URL can be installed.
 * Used by both the CLI installer and the control plane so the trust
 * boundary cannot drift between the two.
 *
 * See docs/specs/APP-ARCHIVE-FORMAT.md Section 5.
 */

const DEFAULT_PATTERNS = [
	"github.com/8gi-foundation/",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com/8gi-foundation/",
	"cdn.8gent.dev",
];

export interface AllowlistOptions {
	/**
	 * Extra host patterns to allow on top of the defaults. Each pattern is
	 * matched against `host + pathname`. A leading `*.` allows any subdomain.
	 */
	extraPatterns?: string[];
	/**
	 * Allow `http://localhost` and `http://127.0.0.1` for local dev.
	 * Defaults to true. Set to false for hardened deployments.
	 */
	allowLocalhost?: boolean;
}

function readEnvPatterns(): string[] {
	const env = process.env.EIGHT_ARCHIVE_ALLOWLIST;
	if (!env) return [];
	return env
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function matchesPattern(hostAndPath: string, pattern: string): boolean {
	if (pattern.startsWith("*.")) {
		const rest = pattern.slice(2);
		// Match either the bare host (no subdomain) or any subdomain.
		return hostAndPath === rest || hostAndPath.endsWith(`.${rest}`) ||
			hostAndPath.startsWith(`${rest}/`) || hostAndPath.includes(`.${rest}/`);
	}
	return hostAndPath === pattern || hostAndPath.startsWith(pattern);
}

/**
 * Decide whether `url` is allowed to serve an app archive.
 *
 * Rejects:
 *   - non-HTTPS (except localhost when enabled)
 *   - URLs containing credentials (`user:pass@`)
 *   - hosts not matched by any allowlist pattern
 */
export function isAllowedArchiveUrl(url: string, options: AllowlistOptions = {}): boolean {
	const allowLocalhost = options.allowLocalhost ?? true;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.username || parsed.password) return false;

	const isLocalhost =
		parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";

	if (parsed.protocol !== "https:") {
		if (parsed.protocol === "http:" && allowLocalhost && isLocalhost) {
			return true;
		}
		return false;
	}

	const hostAndPath = `${parsed.host}${parsed.pathname}`;
	const patterns = [...DEFAULT_PATTERNS, ...(options.extraPatterns ?? []), ...readEnvPatterns()];
	for (const p of patterns) {
		if (matchesPattern(hostAndPath, p)) return true;
	}
	return false;
}

/** Test-only: expose the default pattern list for assertions. */
export function getDefaultPatterns(): string[] {
	return [...DEFAULT_PATTERNS];
}
