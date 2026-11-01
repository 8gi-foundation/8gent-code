/**
 * Cloud metadata hosts (#5198). On a cloud machine 169.254.169.254 and its kin
 * hand out instance credentials, so no tool may treat a request to one as an
 * ordinary fetch. Pure functions on the literal text; nothing here resolves a
 * name, so a DNS answer can never change the verdict.
 */

/** The named reason a refusal carries. */
export const CLOUD_METADATA_REASON = "cloud_metadata_host";

const METADATA_NAMES = new Set([
	"metadata",
	"metadata.google.internal",
	"metadata.azure.com",
	"instance-data",
	"instance-data.ec2.internal",
]);

/** Parse one inet_aton-style number: decimal, 0octal or 0xhex. Null when it is not one. */
function parseNumber(part: string): number | null {
	if (/^0x[0-9a-f]*$/i.test(part)) return part.length === 2 ? 0 : Number.parseInt(part, 16);
	if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
	if (/^(0|[1-9][0-9]*)$/.test(part)) return Number.parseInt(part, 10);
	return null;
}

/** An IPv4 literal in any inet_aton form (1 to 4 parts) as a 32-bit number, or null. */
export function parseIPv4(host: string): number | null {
	const parts = host.split(".");
	if (parts.length < 1 || parts.length > 4) return null;
	const nums: number[] = [];
	for (const p of parts) {
		const n = parseNumber(p);
		if (n === null || !Number.isFinite(n)) return null;
		nums.push(n);
	}
	const last = nums[nums.length - 1];
	const lead = nums.slice(0, -1);
	if (lead.some((n) => n > 255)) return null;
	const room = 2 ** (8 * (5 - nums.length));
	if (last >= room) return null;
	let value = last;
	lead.forEach((n, i) => {
		value += n * 2 ** (8 * (3 - i));
	});
	return value;
}

/** Expand an IPv6 literal to eight 16-bit groups, or null. An embedded dotted tail counts as two groups. */
function parseIPv6(host: string): number[] | null {
	let h = host;
	const zone = h.indexOf("%");
	if (zone >= 0) h = h.slice(0, zone);
	if (!h.includes(":")) return null;
	const tail = h.match(/^(.*:)([^:]+\.[^:]+)$/);
	if (tail) {
		const v4 = parseIPv4(tail[2]);
		if (v4 === null) return null;
		h = `${tail[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = h.split("::");
	if (halves.length > 2) return null;
	const side = (s: string) => (s === "" ? [] : s.split(":"));
	const head = side(halves[0]);
	const rest = halves.length === 2 ? side(halves[1]) : [];
	const fill = 8 - head.length - rest.length;
	if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
	const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
	return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

/**
 * The host of a URL, a host:port, or a bare host: lower case, without scheme,
 * userinfo, port, brackets, path, query or trailing dot. Literal text only.
 */
export function normalizeHost(input: string): string {
	let s = input.trim().replace(/^[\w+.-]+:\/\//, "");
	// A scheme-less "//host/..." and any backslash used as a slash.
	s = s.replace(/\\/g, "/").replace(/^\/+/, "");
	const end = s.search(/[/?#]/);
	if (end >= 0) s = s.slice(0, end);
	const at = s.lastIndexOf("@");
	if (at >= 0) s = s.slice(at + 1);
	if (s.startsWith("[")) {
		const close = s.indexOf("]");
		s = close >= 0 ? s.slice(1, close) : s.slice(1);
	} else if ((s.match(/:/g) ?? []).length === 1) {
		s = s.slice(0, s.indexOf(":"));
	}
	// curl decodes %XX in a host, and URL parsers fold Unicode forms to ASCII: do the same.
	try {
		s = decodeURIComponent(s);
	} catch {
		// keep the raw text on a malformed escape
	}
	s = s.normalize("NFKC").replace(/[\u3002\uff0e\uff61]/g, ".");
	return s.toLowerCase().replace(/\.+$/, "");
}

function v4IsMetadata(n: number): boolean {
	const a = n >>> 24;
	const b = (n >>> 16) & 255;
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local, incl. .169.254
	if (n === ((100 << 24) | (100 << 16) | (100 << 8) | 200) >>> 0) return true; // Alibaba
	if (n === ((192 << 24) | (0 << 16) | (0 << 8) | 192) >>> 0) return true; // Oracle
	return false;
}

/** True when `host` (a URL, host:port or bare host, in any literal form) is a cloud metadata address or name. */
export function isCloudMetadataHost(host: string): boolean {
	const h = normalizeHost(host);
	if (h === "") return false;
	if (METADATA_NAMES.has(h)) return true;

	const v4 = parseIPv4(h);
	if (v4 !== null) return v4IsMetadata(v4);

	const g = parseIPv6(h);
	if (g) {
		if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if (
			g[0] === 0xfd00 &&
			g[1] === 0x0ec2 &&
			g.slice(2, 7).every((x) => x === 0) &&
			g[7] === 0x254
		) {
			return true; // fd00:ec2::254, the AWS IPv6 endpoint
		}
		// NAT64 64:ff9b::/96 carries an IPv4 address in its last 32 bits.
		if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
			return v4IsMetadata(((g[6] << 16) | g[7]) >>> 0);
		}
		// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) carry an IPv4 address.
		const lead = g.slice(0, 5).every((x) => x === 0);
		if (lead && (g[5] === 0xffff || g[5] === 0)) {
			return v4IsMetadata(((g[6] << 16) | g[7]) >>> 0);
		}
	}
	return false;
}

/**
 * The first token of `words` that names a cloud metadata host, or null. Looks
 * at each word as a URL or host, after an option's `=` (--url=http://...), and
 * at URLs embedded in a longer word. A bare name (`metadata`, `instance-data`)
 * matches only as the whole word, never as a substring or an option value.
 */
export function findMetadataHost(words: string[]): string | null {
	for (const word of words) {
		const candidates = [word];
		// An option value counts unless it is a bare name: `--name=metadata` is not a host.
		const eq = word.indexOf("=");
		if (eq > 0) {
			const value = word.slice(eq + 1);
			if (value.includes("://") || !METADATA_NAMES.has(normalizeHost(value)))
				candidates.push(value);
		}
		for (const m of word.matchAll(/[\w+.-]+:\/\/[^\s'"`<>)]+/g)) candidates.push(m[0]);
		for (const c of candidates) if (isCloudMetadataHost(c)) return c;
	}
	return null;
}
