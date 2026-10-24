/**
 * Scouts, slice 1 (#4926): a routine that reads sources the person listed and writes what
 * matches their keywords to a local file. No model, no install.
 *
 * Local by default: the only thing that leaves the device is a GET for each URL the person
 * listed and agreed to (https, default port, no credentials, no body, no cookies). A redirect
 * is followed only to another host from the same list. Results are files under
 * <home>/.8gent/scouts/<routine id>/ (0600, in 0700 directories).
 *
 * Consent is part of the data: a scout carries the hash of the sources the person said yes to,
 * and a scout whose sources were edited afterwards fetches nothing until they say yes again.
 */

import { createHash } from "node:crypto";
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

/** A listed URL: https, no userinfo, the default port. Throws ScoutError otherwise. */
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
	opts: { timeoutMs?: number; maxBytes?: number } = {},
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
