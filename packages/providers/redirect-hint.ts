/**
 * Calls to a user-configured judge or model URL refuse redirects (#4864): a 3xx would re-send the
 * prompt and any Bearer key to a host the user did not name. The refusal is right, but Bun's bare
 * "UnexpectedRedirect" does not say what to do. A reverse proxy that sends http to https (Caddy
 * answers 308) is the usual cause, so say which setting to change.
 */

export function isRedirectError(err: unknown): boolean {
	const e = err as { code?: unknown; message?: unknown } | null;
	return e?.code === "UnexpectedRedirect" || /UnexpectedRedirect/.test(String(e?.message ?? ""));
}

/** Host and port only: never the userinfo, path or query of a configured URL. "" when unreadable. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/** The sentence to show the user, or "" when `err` is not a refused redirect. Never throws. */
export function redirectHint(err: unknown, url: string, setting: string): string {
	if (!isRedirectError(err)) return "";
	const host = hostOf(url);
	const subject = host ? `the URL ${host}` : "the configured URL";
	return `${subject} redirected; set the https URL in ${setting}`;
}

/**
 * The message to show for a failed call: for a refused redirect, the hint ALONE. Bun's own message
 * quotes the full request URL, userinfo and query string included, which can carry a password or a
 * token. Any other error keeps its message.
 */
export function failureMessage(err: unknown, url: string, setting: string): string {
	const hint = redirectHint(err, url, setting);
	if (hint) return `refused redirect: ${hint}`;
	return err instanceof Error ? err.message : String(err);
}

/** `err` rebuilt from the hint alone when it is a refused redirect, else `err` itself. */
export function withRedirectHint(err: unknown, url: string, setting: string): unknown {
	if (!isRedirectError(err)) return err;
	return new Error(failureMessage(err, url, setting));
}
