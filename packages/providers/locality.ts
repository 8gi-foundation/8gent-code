/**
 * Sovereign meter (#4607): where each model call ran, and what left this machine.
 *
 * Three small parts, all pure except the two file helpers:
 *   1. routing policy (local-only | local-first | cloud-first) kept in
 *      ~/.8gent/settings.json under routing.policy, and decideRoute(), the one
 *      table that says whether a call may go ahead.
 *   2. ledger: one JSON line per model call in ~/.8gent/locality.jsonl. The line
 *      is built from numbers and a provider name only, so no prompt or reply
 *      text can reach it.
 *   3. meter: share of tokens that stayed local, today and this session.
 *
 * "Local" is decided by the caller (runsOnBox in packages/eight), which reads
 * local-providers.ts. Nothing here names a model.
 */
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RoutingPolicy = "local-only" | "local-first" | "cloud-first";
export const ROUTING_POLICIES: readonly RoutingPolicy[] = [
	"local-only",
	"local-first",
	"cloud-first",
];
export const DEFAULT_POLICY: RoutingPolicy = "local-first";

export function isRoutingPolicy(v: unknown): v is RoutingPolicy {
	return typeof v === "string" && (ROUTING_POLICIES as readonly string[]).includes(v);
}

export interface RouteInput {
	policy: RoutingPolicy;
	provider: string;
	/** True when the call runs on this machine. */
	local: boolean;
	/** True when the person picked this provider for this tab. */
	pickedForTab: boolean;
	/** Whether a configured local provider answers right now. Unknown: leave undefined. */
	localReachable?: boolean;
	/** Why the policy is what it is, when it was forced (settings.json unreadable). */
	why?: string;
}

export type RouteDecision =
	| { action: "allow-local" }
	| { action: "allow-cloud"; notice: string }
	| { action: "use-local"; notice: string }
	| { action: "refuse"; message: string };

/** The policy table. Pure. A cloud call is never allowed silently: it carries a notice. */
export function decideRoute(i: RouteInput): RouteDecision {
	if (i.local) return { action: "allow-local" };
	if (i.policy === "local-only") {
		return {
			action: "refuse",
			message: `Routing policy is local-only, so this was not sent to ${i.provider}. local-only covers model and network requests sent through 8gent's own HTTP client (see /privacy for what it does not yet cover). Pick a local model with /model, or change the policy with /route local-first.${i.why ? ` Note: ${i.why}` : ""}`,
		};
	}
	if (i.policy === "cloud-first") {
		return { action: "allow-cloud", notice: `Sent to ${i.provider} (policy: cloud-first).` };
	}
	if (i.pickedForTab) {
		return {
			action: "allow-cloud",
			notice: `Sent to ${i.provider}, the provider you picked for this tab.`,
		};
	}
	if (i.localReachable === true) {
		return {
			action: "use-local",
			notice: `Local provider is reachable, so ${i.provider} was not used.`,
		};
	}
	return {
		action: "allow-cloud",
		notice: `Local provider unavailable, so this went to ${i.provider}.`,
	};
}

// ---------- policy storage ----------

const root = () => join(process.env.HOME || homedir(), ".8gent");
export const settingsPath = () => join(root(), "settings.json");
export const ledgerPath = () => join(root(), "locality.jsonl");

export interface PolicyState {
	policy: RoutingPolicy;
	/** Plain reason, set only when the policy was forced to local-only by a bad settings file. */
	why?: string;
	/** routing.localHosts: extra hosts that count as this machine (a LAN box). */
	localHosts: string[];
}

const FORCED = (why: string): PolicyState => ({ policy: "local-only", why, localHosts: [] });

/**
 * The routing policy, failing closed. Only a settings.json that does not exist, or
 * one that parses and has no routing.policy, gives the default (local-first).
 * A file that exists but cannot be read, is empty, is truncated, is not an object,
 * or names an unknown policy gives local-only plus a plain reason. A leading BOM
 * is ignored; case and spaces in the value are ignored ("Local-Only" is local-only).
 */
export function readPolicyState(file?: string): PolicyState {
	// Under `bun test` the real settings file is never read unless a test names one.
	if (!file && process.env.NODE_ENV === "test") return { policy: DEFAULT_POLICY, localHosts: [] };
	const path = file ?? settingsPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e: any) {
		if (e?.code === "ENOENT") return { policy: DEFAULT_POLICY, localHosts: [] };
		return FORCED(
			`settings.json exists but could not be read (${e?.code ?? "error"}), so model calls are held to this machine.`,
		);
	}
	if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
	if (raw.trim() === "") {
		return FORCED("settings.json is empty, so model calls are held to this machine.");
	}
	let v: any;
	try {
		v = JSON.parse(raw);
	} catch {
		return FORCED("settings.json could not be parsed, so model calls are held to this machine.");
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		return FORCED(
			"settings.json is not a settings object, so model calls are held to this machine.",
		);
	}
	const r = v.routing;
	if (r === undefined) return { policy: DEFAULT_POLICY, localHosts: [] };
	if (!r || typeof r !== "object" || Array.isArray(r)) {
		return FORCED(
			"settings.json routing is not an object, so model calls are held to this machine.",
		);
	}
	const hosts = Array.isArray(r.localHosts)
		? r.localHosts.filter((h: unknown) => typeof h === "string").map(normaliseHostEntry)
		: [];
	if (r.policy === undefined) return { policy: DEFAULT_POLICY, localHosts: hosts };
	const want = typeof r.policy === "string" ? r.policy.trim().toLowerCase() : "";
	if (!isRoutingPolicy(want)) {
		return {
			policy: "local-only",
			why: `settings.json routing.policy is not one of ${ROUTING_POLICIES.join(", ")}, so model calls are held to this machine.`,
			localHosts: hosts,
		};
	}
	return { policy: want, localHosts: hosts };
}

/** The saved policy (see readPolicyState). */
export function readPolicy(file?: string): RoutingPolicy {
	return readPolicyState(file).policy;
}

// ---------- which hosts are this machine ----------

/** Lower case, brackets and a trailing dot removed. */
export function normaliseHost(h: string): string {
	let x = h.trim().toLowerCase();
	if (x.startsWith("[") && x.endsWith("]")) x = x.slice(1, -1);
	while (x.endsWith(".")) x = x.slice(0, -1);
	return x;
}

/** A routing.localHosts entry: "host" or "host:port", host normalised. */
function normaliseHostEntry(e: string): string {
	const t = e.trim().toLowerCase();
	const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(t);
	return m ? `${normaliseHost(m[1])}:${m[2]}` : normaliseHost(t);
}

/** Loopback: 127.0.0.0/8, ::1, IPv4-mapped loopback, 0.0.0.0, localhost and *.localhost. */
export function isLoopbackHost(host: string): boolean {
	const h = normaliseHost(host);
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "0.0.0.0" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	// URL() writes the mapped form in hex: ::ffff:7f00:1
	return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
}

/** True when `host` (with optional port) is this machine: loopback or on the user's localHosts list. */
export function isLocalHost(host: string, port: string, localHosts: readonly string[]): boolean {
	if (isLoopbackHost(host)) return true;
	const h = normaliseHost(host);
	return localHosts.includes(h) || (port !== "" && localHosts.includes(`${h}:${port}`));
}

/** Save the policy, keeping every other setting as it was. Refuses to overwrite a file it cannot parse. */
export function writePolicy(policy: RoutingPolicy, file: string = settingsPath()): void {
	let s: Record<string, any> = {};
	let raw: string | null = null;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e: any) {
		if (e?.code !== "ENOENT")
			throw new Error(`settings.json could not be read (${e?.code ?? "error"})`);
	}
	if (raw !== null) {
		if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
		if (raw.trim() !== "") {
			try {
				const v = JSON.parse(raw);
				if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
				s = v;
			} catch {
				throw new Error(
					"settings.json could not be parsed, so it was left alone. Fix or remove it, then run /route again.",
				);
			}
		}
	}
	s.routing = { ...(typeof s.routing === "object" && s.routing ? s.routing : {}), policy };
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
	renameSync(tmp, file);
}

/** /route [policy]. No argument shows the current policy. */
export function routeCommand(arg: string | undefined, file: string = settingsPath()): string {
	const want = (arg ?? "").trim().toLowerCase();
	if (!want) {
		const st = readPolicyState(file);
		return `Routing policy: ${st.policy}.${st.why ? ` ${st.why}` : ""} Change with /route ${ROUTING_POLICIES.join(" | ")}.`;
	}
	if (!isRoutingPolicy(want)) {
		return `Unknown policy "${want}". Choose one of: ${ROUTING_POLICIES.join(", ")}.`;
	}
	try {
		writePolicy(want, file);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	return `Routing policy set to ${want}.`;
}

// ---------- ledger ----------

export interface LedgerEntry {
	/** Joins the completion update (see updateCall) to this line. */
	id?: string;
	/** "other": an off-box request that is not a model call. Listed, never counted in the share. */
	kind?: "other";
	ts: string;
	session: string;
	provider: string;
	local: boolean;
	tokensIn: number;
	tokensOut: number;
	/** Request body size on the wire; 0 for local calls. */
	bytesSent: number;
	/** True when the endpoint sent no usage and the tokens are bytes / 4. */
	est?: boolean;
}

/** One id per process, so /privacy can split "this session" from "today". */
export const SESSION_ID = randomUUID();

const num = (n: unknown) =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/** Build a line from numbers and a provider name only. There is no field for text. */
export interface CallInfo {
	provider: string;
	local: boolean;
	tokensIn: number;
	tokensOut: number;
	/** Exact request body bytes when known; else prompt tokens x 4. */
	bytesSent?: number;
	est?: boolean;
	kind?: "other";
}

export function makeEntry(call: CallInfo, now: Date = new Date()): LedgerEntry {
	const tokensIn = num(call.tokensIn);
	return {
		id: randomUUID().slice(0, 8),
		...(call.kind ? { kind: call.kind } : {}),
		ts: now.toISOString(),
		session: SESSION_ID,
		provider: String(call.provider),
		local: call.local === true,
		tokensIn,
		tokensOut: num(call.tokensOut),
		bytesSent: call.local ? 0 : call.bytesSent !== undefined ? num(call.bytesSent) : tokensIn * 4,
		...(call.est ? { est: true } : {}),
	};
}

type LedgerListener = (e: LedgerEntry) => void;
const ledgerListeners = new Set<LedgerListener>();
/** The TUI hears every recorded call here, so the chip needs no file read per step. */
export function onLedgerEntry(fn: LedgerListener): () => void {
	ledgerListeners.add(fn);
	return () => ledgerListeners.delete(fn);
}

function appendPrivate(file: string, line: string): void {
	// ~/.8gent is created 0700 and the ledger 0600: it says when and where you worked.
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, line, { mode: 0o600 });
}

/** Append one call. Never throws: a full disk must not break a model turn. A call is logged even with zero counts. */
export function recordCall(call: CallInfo, file?: string): LedgerEntry | null {
	const e = makeEntry(call);
	// Under `bun test` the real ledger is never written unless a test names a file.
	if (!file && process.env.NODE_ENV === "test") return null;
	file = file ?? ledgerPath();
	try {
		appendPrivate(file, `${JSON.stringify(e)}\n`);
		for (const fn of ledgerListeners) {
			try {
				fn(e);
			} catch {
				// a listener must never break a call
			}
		}
		return e;
	} catch {
		return null;
	}
}

/**
 * The reply finished: append the real counts for a line written at send time.
 * readLedger folds this onto its call, so a call is still one entry. A reply
 * that is never read leaves the send-time line (estimated) standing.
 */
export function updateCall(
	id: string | undefined,
	usage: { tokensIn: number; tokensOut: number; est?: boolean },
	file?: string,
): void {
	if (!id) return;
	if (!file && process.env.NODE_ENV === "test") return;
	try {
		appendPrivate(
			file ?? ledgerPath(),
			`${JSON.stringify({ upd: id, tokensIn: num(usage.tokensIn), tokensOut: num(usage.tokensOut), ...(usage.est ? { est: true } : {}) })}\n`,
		);
	} catch {
		// never break a call
	}
}

/** Most the meter reads from the end of the ledger: a day of calls is far smaller. */
export const LEDGER_TAIL_BYTES = 1024 * 1024;

/** The last `maxBytes` of the ledger, whole lines only. Never reads the whole file. */
export function readLedger(
	file: string = ledgerPath(),
	maxBytes: number = LEDGER_TAIL_BYTES,
): LedgerEntry[] {
	let raw = "";
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - maxBytes);
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			raw = buf.toString("utf8");
			// a cut start leaves a partial first line: drop it
			if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
	const out: LedgerEntry[] = [];
	const byId = new Map<string, LedgerEntry>();
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e.upd === "string") {
				const t = byId.get(e.upd);
				if (t) {
					t.tokensIn = num(e.tokensIn);
					t.tokensOut = num(e.tokensOut);
					if (e.est) t.est = true;
					else delete t.est;
				}
			} else if (e && typeof e.ts === "string" && typeof e.provider === "string") {
				out.push(e);
				if (typeof e.id === "string") byId.set(e.id, e);
			}
		} catch {
			// a torn line is skipped, never fatal
		}
	}
	return out;
}

// ---------- meter ----------

export interface Meter {
	calls: number;
	localTokens: number;
	cloudTokens: number;
	/** Whole percent of tokens that stayed local; null when nothing was measured. */
	localPct: number | null;
	cloudCalls: LedgerEntry[];
	/** Off-box requests that are not model calls: listed, not in the share. */
	otherCalls: LedgerEntry[];
}

const tokensOf = (e: LedgerEntry) => num(e.tokensIn) + num(e.tokensOut);

export function meterOf(entries: LedgerEntry[]): Meter {
	let localTokens = 0;
	let cloudTokens = 0;
	const cloudCalls: LedgerEntry[] = [];
	const otherCalls: LedgerEntry[] = [];
	for (const e of entries) {
		if (e.kind === "other") otherCalls.push(e);
		else if (e.local) localTokens += tokensOf(e);
		else {
			cloudTokens += tokensOf(e);
			cloudCalls.push(e);
		}
	}
	const total = localTokens + cloudTokens;
	return {
		calls: entries.length - otherCalls.length,
		localTokens,
		cloudTokens,
		localPct: total === 0 ? null : Math.round((localTokens / total) * 100),
		cloudCalls,
		otherCalls,
	};
}

const sameLocalDay = (iso: string, now: Date) => {
	const d = new Date(iso);
	return (
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	);
};

export function todayEntries(entries: LedgerEntry[], now: Date = new Date()): LedgerEntry[] {
	return entries.filter((e) => sameLocalDay(e.ts, now));
}

export function sessionEntries(
	entries: LedgerEntry[],
	session: string = SESSION_ID,
): LedgerEntry[] {
	return entries.filter((e) => e.session === session);
}

/** The status-bar chip. Null until a call has been measured today. */
export function chipText(entries: LedgerEntry[], now: Date = new Date()): string | null {
	const m = meterOf(todayEntries(entries, now));
	return m.localPct === null ? null : `${m.localPct}% of model tokens on this machine`;
}

const fmtBytes = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

function section(title: string, m: Meter): string[] {
	const share =
		m.localPct === null
			? "no measured calls yet"
			: `${m.localPct}% of model tokens on this machine`;
	const lines = [
		`${title}: ${share} (${m.localTokens} local tokens, ${m.cloudTokens} cloud tokens, ${m.calls} calls)`,
	];
	for (const c of m.cloudCalls.slice(-10)) {
		lines.push(
			`  cloud  ${c.ts.slice(11, 19)}  ${c.provider}  ${tokensOf(c)} tokens, about ${fmtBytes(c.bytesSent)} sent`,
		);
	}
	if (m.cloudCalls.length > 10)
		lines.push(`  (${m.cloudCalls.length - 10} earlier cloud calls not shown)`);
	for (const c of m.otherCalls.slice(-5)) {
		lines.push(
			`  other  ${c.ts.slice(11, 19)}  ${c.provider}  about ${fmtBytes(c.bytesSent)} sent (not a model call)`,
		);
	}
	return lines;
}

/** What local-only does not yet cover. Shown by /privacy so the promise is not larger than the guard. */
export const LOCAL_ONLY_GAPS =
	"local-only covers model and network requests sent through 8gent's own HTTP client. It does not yet cover run_command tools such as curl, clients that do not use that HTTP client, or child processes that do not load the guard.";

/** /privacy. Sizes only; the ledger holds no text to show. */
export function privacyReport(
	entries: LedgerEntry[],
	policy: RoutingPolicy,
	now: Date = new Date(),
	session: string = SESSION_ID,
	why?: string,
): string {
	return [
		`Routing policy: ${policy} (change with /route)${why ? ` - ${why}` : ""}`,
		...section("Today", meterOf(todayEntries(entries, now))),
		...section("This session", meterOf(sessionEntries(entries, session))),
		LOCAL_ONLY_GAPS,
	].join("\n");
}
