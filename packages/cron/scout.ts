/**
 * Scouts, slice 1 (#4926): a routine that reads sources the person listed and writes what
 * matches their keywords to a local file. No model, no install.
 *
 * Local by default: the only thing that leaves the device is a GET for each URL the person
 * listed and agreed to (https, default port, no credentials, no body, no cookies). A redirect
 * is followed only to another host from the same list. Results are files under
 * <home>/.8gent/scouts/<routine id>/ (0600, in 0700 directories).
 *
 * A listed address can never be this machine or a private network (SSRF): loopback, private,
 * link-local, CGNAT, unique-local, IPv4-mapped IPv6, localhost, single-label names and
 * .local/.internal-style names are refused when the URL is read and again, by resolved
 * address, before every request and every redirect hop. Limit, stated plainly: the check
 * resolves the name and then fetch resolves it again to connect, so a DNS answer that changes
 * between the two (rebinding) is narrowed, not closed.
 *
 * Consent is part of the data: a scout carries the hash of the sources the person said yes to,
 * and a scout whose sources were edited afterwards fetches nothing until they say yes again.
 */

import { createHash } from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";

type Env = Record<string, string | undefined>;

export interface ScoutSource {
	id: string;
	url: string;
}
export interface ScoutSpec {
	sources: ScoutSource[];
	keywords: string[];
	notify?: "local";
}

export class ScoutError extends Error {}

const MAX_SOURCES = 20;
const MAX_KEYWORDS = 20;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROUTINE_ID_RE = /^[a-z0-9-]{1,64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── internal addresses ───────────────────────────────────────────────────

function parseV4(s: string): number[] | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return null;
	const o = m.slice(1).map(Number);
	return o.every((n) => n <= 255) ? o : null;
}

function v4Internal([a, b, c]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224 // multicast, reserved, broadcast
	);
}

function parseV6(raw: string): number[] | null {
	let h = raw.toLowerCase();
	if (h.includes(".")) {
		const i = h.lastIndexOf(":");
		const v4 = parseV4(h.slice(i + 1));
		if (!v4) return null;
		h = `${h.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const parts = h.split("::");
	if (parts.length > 2) return null;
	const head = parts[0] ? parts[0].split(":") : [];
	const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
	let groups: string[];
	if (parts.length === 1) {
		if (head.length !== 8) return null;
		groups = head;
	} else {
		const fill = 8 - head.length - tail.length;
		if (fill < 1) return null;
		groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
	}
	if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	return groups.map((g) => Number.parseInt(g, 16));
}

function v6Internal(g: number[]): boolean {
	const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
	return zeros(0, 5) && (g[5] === 0xffff || g[5] === 0) // ::, ::1, IPv4-mapped and IPv4-compatible
		? true
		: (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) || // NAT64
				g[0] === 0x2002 || // 6to4
				(g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) || // Teredo, documentation
				(g[0] === 0x0100 && zeros(1, 4)) || // discard
				(g[0] & 0xfe00) === 0xfc00 || // unique-local
				(g[0] & 0xffc0) === 0xfe80 || // link-local
				(g[0] & 0xffc0) === 0xfec0 || // site-local
				(g[0] & 0xff00) === 0xff00; // multicast
}

/** True for an address that is this machine or a private network, and for anything that is not an address. */
export function isInternalAddress(addr: string): boolean {
	const a = addr
		.trim()
		.replace(/^\[|\]$/g, "")
		.replace(/%.*$/, "");
	const v4 = parseV4(a);
	if (v4) return v4Internal(v4);
	const v6 = parseV6(a);
	return v6 ? v6Internal(v6) : true;
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

const isIpLiteral = (host: string) => host.startsWith("[") || parseV4(host) !== null;

/** Why a (WHATWG-normalised) hostname may not be a source, or null. Decimal, hex and octal IPv4 forms arrive here as dotted decimal. */
export function internalHostReason(hostname: string): string | null {
	const h = hostname.toLowerCase().replace(/\.$/, "");
	if (isIpLiteral(h))
		return isInternalAddress(h)
			? `${h} is an internal address (this machine or a private network)`
			: null;
	if (!h.includes(".") || INTERNAL_SUFFIXES.some((x) => h.endsWith(x)))
		return `${h} is an internal name (this machine or a private network)`;
	return null;
}

/** A listed URL: https, no userinfo, the default port, not internal. Throws ScoutError otherwise. */
export function checkUrl(raw: unknown): URL {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
		throw new ScoutError("a source needs a URL of at most 2048 characters");
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new ScoutError(`not a URL: ${raw.slice(0, 60)}`);
	}
	if (u.protocol !== "https:")
		throw new ScoutError(`sources must be https: ${u.protocol}//${u.host}`);
	if (u.username || u.password)
		throw new ScoutError("a source URL may not carry a user name or password");
	if (u.port) throw new ScoutError("a source URL may not name a port");
	if (!u.hostname) throw new ScoutError("a source URL needs a host");
	const internal = internalHostReason(u.hostname);
	if (internal) throw new ScoutError(internal);
	return u;
}

/** The schema. Anything outside it is refused. Returns the normalised spec. */
export function validateScout(raw: unknown): ScoutSpec {
	if (!isObject(raw)) throw new ScoutError("a scout needs sources and keywords");
	for (const k of Object.keys(raw))
		if (!["sources", "keywords", "notify"].includes(k))
			throw new ScoutError(`unknown scout field: ${k}`);
	const { sources, keywords, notify } = raw;
	if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES)
		throw new ScoutError(`a scout needs 1 to ${MAX_SOURCES} sources`);
	const ids = new Set<string>();
	const urls = new Set<string>();
	const outSources: ScoutSource[] = sources.map((s) => {
		if (!isObject(s)) throw new ScoutError("a source is { id, url }");
		for (const k of Object.keys(s))
			if (k !== "id" && k !== "url") throw new ScoutError(`unknown source field: ${k}`);
		if (typeof s.id !== "string" || !ID_RE.test(s.id))
			throw new ScoutError("a source id is lower-case letters, digits and dashes");
		const u = checkUrl(s.url);
		if (ids.has(s.id)) throw new ScoutError(`source id given twice: ${s.id}`);
		if (urls.has(u.href)) throw new ScoutError(`source URL given twice: ${u.href}`);
		ids.add(s.id);
		urls.add(u.href);
		return { id: s.id, url: s.url as string };
	});
	if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS)
		throw new ScoutError(`at most ${MAX_KEYWORDS} keywords`);
	const outKeywords = keywords.map((k) => {
		if (typeof k !== "string" || k.trim().length === 0 || k.length > 80)
			throw new ScoutError("a keyword is 1 to 80 characters");
		return k;
	});
	if (notify !== undefined && notify !== "local") throw new ScoutError("notify can only be local");
	return { sources: outSources, keywords: outKeywords, ...(notify ? { notify } : {}) };
}

/** What a yes covers: the sources (id and URL), in a fixed order. Keywords stay on the device and are not part of it. */
export function consentHash(spec: ScoutSpec): string {
	const list = [...spec.sources].sort((a, b) => a.id.localeCompare(b.id)).map((s) => [s.id, s.url]);
	return createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

/** The one question, with every address in it. */
export function consentLine(name: string, schedule: string, spec: ScoutSpec): string {
	const urls = spec.sources.map((s) => `  ${s.id}: ${s.url}`).join("\n");
	return `Scout "${name}" will fetch these addresses on schedule "${schedule}" (GET only; nothing else leaves this device):\n${urls}\nEnable it? [y/N]`;
}

/** CI, EIGHT_UNATTENDED or no terminal: nobody can answer. */
export function unattended(env: Env = process.env): boolean {
	const set = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";
	return set(env.CI) || set(env.EIGHT_UNATTENDED) || !process.stdin.isTTY || !process.stdout.isTTY;
}

export type Ask = (line: string, defaultYes: boolean) => Promise<boolean | null>;

/** y/N on the terminal: Enter is a no; null when unattended. */
export function defaultAsk(env: Env = process.env): Ask {
	return async (line) => {
		if (unattended(env)) return null;
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const a = (await rl.question(`${line} `)).trim().toLowerCase();
			return a === "y" || a === "yes";
		} finally {
			rl.close();
		}
	};
}

// ── fetch ────────────────────────────────────────────────────────────────

export type ScoutFetch = (
	url: string,
	init?: {
		method?: "GET";
		headers?: Record<string, string>;
		redirect?: "manual";
		credentials?: "omit";
		signal?: AbortSignal;
	},
) => Promise<Response>;

/** Every address a name resolves to. Injected in tests. */
export type Lookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = async (host) => {
	const r = await dns.promises.lookup(host, { all: true });
	return r.map((x) => ({ address: x.address }));
};

export type SourceResult = { ok: true; text: string } | { ok: false; why: string };

const MAX_HOPS = 3;

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
	if (!res.body) {
		const t = await res.text();
		return t.length > maxBytes ? null : t;
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let got = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		got += value.byteLength;
		if (got > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * GET one listed URL. https only, hosts only from `allow` (the hosts of the person's own list),
 * redirects followed by hand and checked at every hop, no credentials or cookies, a size cap
 * and a timeout. Never throws.
 */
export async function fetchSource(
	f: ScoutFetch,
	url: string,
	allow: ReadonlySet<string>,
	opts: { timeoutMs?: number; maxBytes?: number; lookup?: Lookup } = {},
): Promise<SourceResult> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const maxBytes = opts.maxBytes ?? 1_000_000;
	const ctl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<SourceResult>((resolve) => {
		timer = setTimeout(() => {
			ctl.abort();
			resolve({ ok: false, why: `no answer within ${Math.round(timeoutMs / 1000)} s` });
		}, timeoutMs);
	});
	const work = (async (): Promise<SourceResult> => {
		let cur = url;
		for (let hop = 0; hop <= MAX_HOPS; hop++) {
			let u: URL;
			try {
				u = checkUrl(cur);
			} catch (err) {
				return { ok: false, why: (err as Error).message };
			}
			if (!allow.has(u.hostname))
				return { ok: false, why: `${u.hostname} is not one of your listed sources` };
			// Before every request, redirect hops included: a name that now points inside is refused.
			if (!isIpLiteral(u.hostname)) {
				let answers: { address: string }[];
				try {
					answers = await (opts.lookup ?? defaultLookup)(u.hostname);
				} catch (err) {
					return { ok: false, why: `could not resolve ${u.hostname}: ${(err as Error).message}` };
				}
				if (answers.length === 0) return { ok: false, why: `${u.hostname} did not resolve` };
				const bad = answers.find((x) => isInternalAddress(x.address));
				if (bad)
					return {
						ok: false,
						why: `${u.hostname} resolves to an internal address (${bad.address}): this machine or a private network`,
					};
			}
			const res = await f(u.href, {
				method: "GET",
				headers: {
					"user-agent": "8gent-scout",
					accept: "text/html, application/xml, application/rss+xml, text/plain",
				},
				redirect: "manual",
				credentials: "omit",
				signal: ctl.signal,
			});
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (!loc) return { ok: false, why: "a redirect with no location" };
				cur = new URL(loc, u.href).href;
				continue;
			}
			if (!res.ok) return { ok: false, why: `answered ${res.status}` };
			const text = await readCapped(res, maxBytes);
			return text === null
				? { ok: false, why: `larger than ${maxBytes} bytes` }
				: { ok: true, text };
		}
		return { ok: false, why: "too many redirects" };
	})().catch((err: unknown) => ({
		ok: false as const,
		why: err instanceof Error ? err.message : String(err),
	}));
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// ── run ──────────────────────────────────────────────────────────────────

export function scoutDir(env: Env, routineId: string): string {
	if (!ROUTINE_ID_RE.test(routineId))
		throw new ScoutError(`not a scout id: ${routineId.slice(0, 20)}`);
	return path.join(resolveHome(env), ".8gent", "scouts", routineId);
}

function privateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Both the scouts directory and this scout's own: created by something else, they can be wider.
	for (const d of [dir, path.dirname(dir)]) {
		try {
			const st = fs.lstatSync(d);
			if (st.isDirectory() && (st.mode & 0o077) !== 0) fs.chmodSync(d, st.mode & 0o700);
		} catch {}
	}
}

function writeResult(dir: string, stamp: string, text: string): string {
	privateDir(dir);
	for (let n = 0; n < 1000; n++) {
		const file = path.join(dir, `${stamp}${n ? `-${n}` : ""}.md`);
		if (fs.existsSync(file)) continue;
		const tmp = `${file}.tmp-${process.pid}`;
		const fd = fs.openSync(
			tmp,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				(fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			fs.writeSync(fd, text);
			fs.fchmodSync(fd, 0o600);
		} catch (err) {
			fs.closeSync(fd);
			fs.rmSync(tmp, { force: true });
			throw err;
		}
		fs.closeSync(fd);
		try {
			fs.renameSync(tmp, file);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		}
		return file;
	}
	throw new ScoutError("too many results in the same instant");
}

/** Page text from markup: scripts and styles dropped, tags to spaces, a few entities decoded. */
export function plainText(markup: string): string {
	return markup
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/[ \t]+/g, " ");
}

export function matches(text: string, keywords: string[], limit = 20): string[] {
	const sentences = plainText(text)
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const pick =
		keywords.length === 0
			? sentences
			: sentences.filter((s) => keywords.some((k) => s.toLowerCase().includes(k.toLowerCase())));
	return pick.slice(0, limit).map((s) => (s.length > 300 ? `${s.slice(0, 297)}...` : s));
}

export interface ScoutDeps {
	fetchImpl?: ScoutFetch;
	env?: Env;
	now?: () => Date;
	timeoutMs?: number;
	maxBytes?: number;
	lookup?: Lookup;
}

export interface ScoutOutcome {
	status: "completed" | "failed";
	/** The result file, when one was written. */
	file?: string;
	error?: string;
}

/** Run a scout in this process: fetch each listed source, write what matches. One failing source never stops the others. */
export async function runScout(
	routine: { id: string; name: string; scout?: unknown },
	deps: ScoutDeps = {},
): Promise<ScoutOutcome> {
	const env = deps.env ?? process.env;
	let spec: ScoutSpec;
	try {
		const raw = isObject(routine.scout) ? { ...routine.scout } : routine.scout;
		// `consent` lives beside the spec in the store; it is not part of the schema.
		if (isObject(raw)) Reflect.deleteProperty(raw, "consent");
		spec = validateScout(raw);
	} catch (err) {
		return { status: "failed", error: (err as Error).message };
	}
	const f: ScoutFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i as RequestInit));
	const allow = new Set(spec.sources.map((s) => new URL(s.url).hostname));
	const now = (deps.now ?? (() => new Date()))();
	const lines = [`# Scout: ${routine.name}`, "", `Run at ${now.toISOString()}`, ""];
	let okCount = 0;
	for (const s of spec.sources) {
		const r = await fetchSource(f, s.url, allow, {
			timeoutMs: deps.timeoutMs,
			maxBytes: deps.maxBytes,
			lookup: deps.lookup,
		});
		lines.push(`## ${s.id}`, "", s.url, "");
		if (!r.ok) {
			lines.push(`Status: failed: ${r.why}`, "");
			continue;
		}
		okCount++;
		const hits = matches(r.text, spec.keywords);
		lines.push(`Status: ok, ${hits.length} match${hits.length === 1 ? "" : "es"}`, "");
		for (const h of hits) lines.push(`- ${h}`);
		if (hits.length) lines.push("");
	}
	try {
		const file = writeResult(
			scoutDir(env, routine.id),
			now.toISOString().replace(/[:.]/g, "-"),
			`${lines.join("\n")}\n`,
		);
		return okCount === 0
			? { status: "failed", file, error: "every source failed; see the result file" }
			: { status: "completed", file };
	} catch (err) {
		return { status: "failed", error: `could not write the result: ${(err as Error).message}` };
	}
}
