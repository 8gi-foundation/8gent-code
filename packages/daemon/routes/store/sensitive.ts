/**
 * Shared sensitive-path detection for the store route.
 *
 * Used by both kg.* (ingestion) and fs.* (write/edit/delete) handlers so the
 * same set of redlines applies regardless of entry point. Two tiers:
 *
 *   - Sensitive (overridable):   credentials, env files, key material, tokens.
 *     Callers can pass `confirmedSensitiveWrite: true` (fs) or
 *     `confirmedNoSecrets: true` (kg) to proceed; both the block and the
 *     override are audited.
 *
 *   - Forbidden (NOT overridable): anything inside `.git/`. Writing to git
 *     internals can corrupt the repo and silently rewrite history; no caller
 *     should ever do this through the daemon, even with confirmation.
 */
const SENSITIVE_FILENAME_RE = [
	// dotenv files: .env, .env.local, .env.production, etc.
	/(^|[\\/])\.env(\..+)?$/i,
	// key material
	/\.pem$/i,
	/\.key$/i,
	/\.pfx$/i,
	/\.p12$/i,
	/\.kdbx$/i,
	// SSH keys
	/(^|[\\/])id_[a-z0-9]+(\.pub)?$/i,
	// generic credential / secret patterns
	/_secret\b/i,
	/_credential\b/i,
	/credentials?\.json$/i,
];

/** Anything under a `.git/` segment is forbidden, no override. */
const FORBIDDEN_PATH_RE = [/(^|[\\/])\.git([\\/]|$)/];

export interface SensitiveCheckResult {
	/** True if the path matched a sensitive pattern (overridable). */
	sensitive: boolean;
	/** True if the path is forbidden (no override). */
	forbidden: boolean;
	/** Human-readable reason matching the rule that fired. */
	reason?: string;
}

/**
 * Classify a path. Forbidden trumps sensitive: if both match, callers should
 * see `forbidden: true` first.
 */
export function classifySensitivePath(filePath: string): SensitiveCheckResult {
	for (const re of FORBIDDEN_PATH_RE) {
		if (re.test(filePath)) {
			return { sensitive: false, forbidden: true, reason: `path inside git internals (${re.source})` };
		}
	}
	for (const re of SENSITIVE_FILENAME_RE) {
		if (re.test(filePath)) {
			return { sensitive: true, forbidden: false, reason: `filename matches sensitive pattern (${re.source})` };
		}
	}
	return { sensitive: false, forbidden: false };
}
