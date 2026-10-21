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
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
			message: `Routing policy is local-only, so this was not sent to ${i.provider}. Nothing left this machine. Pick a local model with /model, or change the policy with /route local-first.`,
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

function readSettings(file: string): Record<string, any> {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}

/** The saved policy; anything missing or unrecognised is the default. */
export function readPolicy(file?: string): RoutingPolicy {
	// Under `bun test` the real settings file is never read unless a test names one.
	if (!file && process.env.NODE_ENV === "test") return DEFAULT_POLICY;
	const p = readSettings(file ?? settingsPath()).routing?.policy;
	return isRoutingPolicy(p) ? p : DEFAULT_POLICY;
}

/** Save the policy, keeping every other setting as it was. */
export function writePolicy(policy: RoutingPolicy, file: string = settingsPath()): void {
	const s = readSettings(file);
	s.routing = { ...(typeof s.routing === "object" && s.routing ? s.routing : {}), policy };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
	renameSync(tmp, file);
}

/** /route [policy]. No argument shows the current policy. */
export function routeCommand(arg: string | undefined, file: string = settingsPath()): string {
	const want = (arg ?? "").trim().toLowerCase();
	if (!want) {
		return `Routing policy: ${readPolicy(file)}. Change with /route ${ROUTING_POLICIES.join(" | ")}.`;
	}
	if (!isRoutingPolicy(want)) {
		return `Unknown policy "${want}". Choose one of: ${ROUTING_POLICIES.join(", ")}.`;
	}
	writePolicy(want, file);
	return `Routing policy set to ${want}.`;
}

// ---------- ledger ----------

export interface LedgerEntry {
	ts: string;
	session: string;
	provider: string;
	local: boolean;
	tokensIn: number;
	tokensOut: number;
	/** Approximate: prompt tokens x 4. The exact request size is not exposed by every endpoint. */
	bytesSent: number;
}

/** One id per process, so /privacy can split "this session" from "today". */
export const SESSION_ID = randomUUID();

const num = (n: unknown) =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/** Build a line from numbers and a provider name only. There is no field for text. */
export function makeEntry(
	call: { provider: string; local: boolean; tokensIn: number; tokensOut: number },
	now: Date = new Date(),
): LedgerEntry {
	const tokensIn = num(call.tokensIn);
	return {
		ts: now.toISOString(),
		session: SESSION_ID,
		provider: String(call.provider),
		local: call.local === true,
		tokensIn,
		tokensOut: num(call.tokensOut),
		bytesSent: call.local ? 0 : tokensIn * 4,
	};
}

/** Append one call. Never throws: a full disk must not break a model turn. Calls with no tokens are skipped. */
export function recordCall(
	call: { provider: string; local: boolean; tokensIn: number; tokensOut: number },
	file?: string,
): LedgerEntry | null {
	const e = makeEntry(call);
	if (e.tokensIn + e.tokensOut === 0) return null;
	// Under `bun test` the real ledger is never written unless a test names a file.
	if (!file && process.env.NODE_ENV === "test") return null;
	file = file ?? ledgerPath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(e)}\n`);
		return e;
	} catch {
		return null;
	}
}

export function readLedger(file: string = ledgerPath()): LedgerEntry[] {
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: LedgerEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e.ts === "string" && typeof e.provider === "string") out.push(e);
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
}

const tokensOf = (e: LedgerEntry) => num(e.tokensIn) + num(e.tokensOut);

export function meterOf(entries: LedgerEntry[]): Meter {
	let localTokens = 0;
	let cloudTokens = 0;
	const cloudCalls: LedgerEntry[] = [];
	for (const e of entries) {
		if (e.local) localTokens += tokensOf(e);
		else {
			cloudTokens += tokensOf(e);
			cloudCalls.push(e);
		}
	}
	const total = localTokens + cloudTokens;
	return {
		calls: entries.length,
		localTokens,
		cloudTokens,
		localPct: total === 0 ? null : Math.round((localTokens / total) * 100),
		cloudCalls,
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
	return m.localPct === null ? null : `${m.localPct}% local today`;
}

const fmtBytes = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

function section(title: string, m: Meter): string[] {
	const share = m.localPct === null ? "no measured calls yet" : `${m.localPct}% local by tokens`;
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
	return lines;
}

/** /privacy. Sizes only; the ledger holds no text to show. */
export function privacyReport(
	entries: LedgerEntry[],
	policy: RoutingPolicy,
	now: Date = new Date(),
	session: string = SESSION_ID,
): string {
	return [
		`Routing policy: ${policy} (change with /route)`,
		...section("Today", meterOf(todayEntries(entries, now))),
		...section("This session", meterOf(sessionEntries(entries, session))),
	].join("\n");
}
