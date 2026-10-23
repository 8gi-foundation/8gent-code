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

/** The sentence to show the user, or "" when `err` is not a refused redirect. Never throws. */
export function redirectHint(err: unknown, url: string, setting: string): string {
	if (!isRedirectError(err)) return "";
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		/* a malformed URL is named as written */
	}
	return `the URL ${host} redirected; set the https URL in ${setting}`;
}

/** `err` with the hint appended to its message, or `err` itself when it is not a redirect. */
export function withRedirectHint(err: unknown, url: string, setting: string): unknown {
	const hint = redirectHint(err, url, setting);
	if (!hint) return err;
	return new Error(`${err instanceof Error ? err.message : String(err)} (${hint})`);
}
