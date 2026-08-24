/**
 * Surfacing gate - one evaluator for background findings.
 *
 * Resonant Flow Wave 1 (doc-04 concept import): background work is allowed to
 * be exploratory and messy; only what improves the user's next moment gets
 * surfaced. Everything else lands silently in the durable record.
 *
 * Rules-first, in order:
 *   1. severity  - blocked/failed markers always surface (flow protection never hides a fire)
 *   2. duplicate - findings that repeat recent memory store silently
 *   3. model     - optional single local-model pass for the ambiguous middle
 *   4. default   - store silently
 *
 * The gate works with no model available (rules-only fallback). Every decision
 * is appended to ~/.8gent/flow/surfacing.jsonl with its reason - an
 * unexplained decision is a bug.
 *
 * "Surface" rides existing channels only (native notification; Telegram only
 * when already configured AND EIGHT_SURFACING_NOTIFY=1). No new channels.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface Finding {
	/** The finding text to evaluate */
	text: string;
	/** Which background path produced it, e.g. "reflection", "autoresearch" */
	source: string;
	sessionId?: string;
	/** Explicit severity from the producer; text markers are checked either way */
	severity?: "info" | "blocked" | "failed";
}

export type GateRule = "disabled" | "empty" | "severity" | "duplicate" | "model" | "default";

export interface GateDecision {
	surface: boolean;
	rule: GateRule;
	reason: string;
}

export interface GateDeps {
	/** Recent-memory lookup for novelty; absent or throwing = novelty unknown */
	recall?: (text: string) => Promise<Array<{ value: string }>>;
	/** Optional single local-model pass; absent or failing = conservative default */
	model?: (prompt: string) => Promise<string>;
	/** Decision log path; default ~/.8gent/flow/surfacing.jsonl */
	logPath?: string;
	now?: () => Date;
	/** Routing for surfaced findings; default rides the existing notification path */
	notify?: (title: string, body: string, decision: GateDecision) => Promise<void>;
}

// ── Rules ──────────────────────────────────────────────────────────────

const SEVERITY_PATTERN =
	/\b(blocked|failed|failure|fatal|breach|leaked?|credential|security)\b|\berror:/i;

/** Soft signals that make a novel finding worth one model pass */
const SOFT_SIGNAL_PATTERN = /\b(recommend|opportunity|significant|regression|deadline|urgent)\b/i;

/** Token-set Jaccard overlap; >= DUPLICATE_THRESHOLD means duplicate */
const DUPLICATE_THRESHOLD = 0.6;

function tokenSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2),
	);
}

export function overlap(a: string, b: string): number {
	const sa = tokenSet(a);
	const sb = tokenSet(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let shared = 0;
	for (const t of sa) if (sb.has(t)) shared++;
	return shared / (sa.size + sb.size - shared);
}

export function gateEnabled(): boolean {
	return process.env.EIGHT_SURFACING_GATE !== "0";
}

// ── Decision log ───────────────────────────────────────────────────────

/** Repo convention (see evolution-db.ts): EIGHT_DATA_DIR overrides ~/.8gent,
 *  which is how tests sandbox all on-disk state. Resolved lazily on purpose. */
function dataDir(): string {
	return process.env.EIGHT_DATA_DIR || join(homedir(), ".8gent");
}

export function defaultLogPath(): string {
	return join(dataDir(), "flow", "surfacing.jsonl");
}

function logDecision(finding: Finding, decision: GateDecision, deps: GateDeps): void {
	const logPath = deps.logPath ?? defaultLogPath();
	const entry = {
		ts: (deps.now?.() ?? new Date()).toISOString(),
		source: finding.source,
		sessionId: finding.sessionId,
		surface: decision.surface,
		rule: decision.rule,
		reason: decision.reason,
		preview: (finding.text ?? "").slice(0, 160),
	};
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
	} catch {
		/* logging is best-effort; never take down the background path */
	}
}

// ── Evaluator ──────────────────────────────────────────────────────────

/**
 * Decide whether a background finding earns surfacing now.
 * Deterministic rules first; one optional model pass for the ambiguous middle;
 * conservative default is store-silently. Every call logs its decision.
 */
export async function evaluate(finding: Finding, deps: GateDeps = {}): Promise<GateDecision> {
	// Resolve the log path in the synchronous entry section: fire-and-forget
	// callers may restore EIGHT_DATA_DIR (test sandboxing) before we get
	// scheduled, and the decision must land in the log that was current when
	// the finding was produced.
	const resolved: GateDeps = { ...deps, logPath: deps.logPath ?? defaultLogPath() };
	const decision = await decide(finding, resolved);
	logDecision(finding, decision, resolved);
	return decision;
}

async function decide(finding: Finding, deps: GateDeps): Promise<GateDecision> {
	const text = finding.text.trim();
	if (!text) {
		return { surface: false, rule: "empty", reason: "empty finding text" };
	}

	// Rule 1: severity always surfaces
	if (finding.severity === "blocked" || finding.severity === "failed") {
		return {
			surface: true,
			rule: "severity",
			reason: `producer marked severity=${finding.severity}`,
		};
	}
	const marker = text.match(SEVERITY_PATTERN);
	if (marker) {
		return { surface: true, rule: "severity", reason: `severity marker "${marker[0]}" in text` };
	}

	// Rule 2: duplicates of recent memory store silently
	if (deps.recall) {
		try {
			const recent = await deps.recall(text);
			for (const mem of recent) {
				const o = overlap(text, mem.value);
				if (o >= DUPLICATE_THRESHOLD) {
					return {
						surface: false,
						rule: "duplicate",
						reason: `duplicate of recent memory (overlap ${o.toFixed(2)})`,
					};
				}
			}
		} catch {
			/* novelty unknown; fall through to remaining rules */
		}
	}

	// Rule 3: one model pass for the ambiguous middle (novel + soft signal)
	if (deps.model && SOFT_SIGNAL_PATTERN.test(text)) {
		try {
			const answer = await deps.model(
				`A background agent produced this finding. Answer only YES or NO: should it interrupt the user right now, rather than being stored for later?\n\nFinding: ${text.slice(0, 500)}`,
			);
			if (/^\s*yes\b/i.test(answer)) {
				return { surface: true, rule: "model", reason: "model pass judged surfacing-worthy" };
			}
			if (/^\s*no\b/i.test(answer)) {
				return { surface: false, rule: "model", reason: "model pass judged store-silently" };
			}
			/* unparseable answer: fall through to conservative default */
		} catch {
			/* no model available or call failed: rules-only fallback */
		}
	}

	// Rule 4: conservative default
	return { surface: false, rule: "default", reason: "no surfacing rule matched; stored silently" };
}

// ── Routing (existing channels only) ───────────────────────────────────

/** Best-effort novelty lookup against the existing memory store (packages/memory).
 *  The db path is bound at closure-creation time (see evaluate's entry-section
 *  note on EIGHT_DATA_DIR). */
function memoryRecall(dbPath: string): (text: string) => Promise<Array<{ value: string }>> {
	return async (text) => {
		const { MemoryStore } = await import("../memory/store.js");
		const store = new MemoryStore(dbPath);
		try {
			const results = await store.recall(text.slice(0, 200), { limit: 5 });
			return results.map((r) => ({
				value: String((r.memory as { value?: unknown }).value ?? ""),
			}));
		} finally {
			store.close();
		}
	};
}

/** Default routing: existing channels only. Native notification always; Telegram
 *  only when already configured AND EIGHT_SURFACING_NOTIFY=1. */
async function defaultNotify(title: string, body: string, decision: GateDecision): Promise<void> {
	const { sendNativeNotification, NotificationDispatcher } = await import(
		"../daemon/notifications.js"
	);
	await sendNativeNotification(title, body);
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;
	if (process.env.EIGHT_SURFACING_NOTIFY === "1" && token && chatId) {
		const type = decision.rule === "severity" ? "task-failed" : "task-progress";
		await new NotificationDispatcher(token, chatId).notify(type, `${title}\n${body}`);
	}
}

/**
 * Evaluate a finding and, when it surfaces, route it through the EXISTING
 * notification path. "Store" means the finding stays wherever the producer
 * already persisted it - no extra action here. Never throws.
 */
export async function processFinding(finding: Finding, deps: GateDeps = {}): Promise<GateDecision> {
	if (!gateEnabled()) {
		return { surface: false, rule: "disabled", reason: "EIGHT_SURFACING_GATE=0" };
	}
	// Synchronous entry section: bind default paths while the caller's
	// environment (EIGHT_DATA_DIR) is still current.
	const effectiveDeps: GateDeps = {
		...deps,
		logPath: deps.logPath ?? defaultLogPath(),
		recall: deps.recall ?? memoryRecall(join(dataDir(), "memory.db")),
	};

	// #2883: a finding with no text cannot inform anyone, and an empty body
	// reaches macOS as the literal word "Notification" - the alert the Chair
	// received. Refuse it ahead of the rules so a missing text is a logged
	// decision rather than a throw, and bind the body once.
	const body = (finding.text ?? "").trim().slice(0, 300);
	if (!body) {
		const skipped: GateDecision = {
			surface: false,
			rule: "empty",
			reason: "empty finding text; nothing to surface",
		};
		logDecision(finding, skipped, effectiveDeps);
		return skipped;
	}

	const decision = await evaluate(finding, effectiveDeps);
	if (!decision.surface) return decision;

	try {
		const notify = deps.notify ?? defaultNotify;
		await notify(`8gent - ${finding.source} finding`, body, decision);
	} catch {
		/* notification path unavailable; the decision log is the durable record */
	}
	return decision;
}
