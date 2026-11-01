/** A MISP feed is a base URL that serves manifest.json plus <uuid>.json per event. */
export interface MispSource {
	/** Directory-safe name, used under the store root. */
	name: string;
	/** Feed base URL, no trailing slash. https only when a key is set. */
	baseUrl: string;
	/** Optional MISP auth key. Sent as the Authorization header, never logged or stored. */
	authKey?: string;
}

export const CIRCL_OSINT: MispSource = {
	name: "circl-osint",
	baseUrl: "https://www.circl.lu/doc/misp/feed-osint",
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function envKeyName(name: string): string {
	return `THREAT_FEED_MISP_${name.toUpperCase().replace(/-/g, "_")}_KEY`;
}

/** Build a source. The key comes from env only, THREAT_FEED_MISP_<NAME>_KEY, never from argv. */
export function makeSource(
	name: string,
	baseUrl: string,
	env: Record<string, string | undefined> = process.env,
): MispSource {
	if (!NAME_RE.test(name)) throw new Error(`bad source name ${JSON.stringify(name)}`);
	let u: URL;
	try {
		u = new URL(baseUrl);
	} catch {
		throw new Error("bad feed url");
	}
	const authKey = env[envKeyName(name)] || undefined;
	if (u.protocol !== "https:" && !(u.protocol === "http:" && !authKey)) {
		throw new Error("feed url must be https when an auth key is set");
	}
	return { name, baseUrl: baseUrl.replace(/\/+$/, ""), authKey };
}

/** "name=https://host/feed" pairs from --source flags. */
export function parseSourceFlag(v: string, env?: Record<string, string | undefined>): MispSource {
	const i = v.indexOf("=");
	if (i < 1) throw new Error("--source expects name=url");
	return makeSource(v.slice(0, i), v.slice(i + 1), env);
}
