/**
 * Friction record (#4511): counts of how hard a session was to use. Pure, no I/O, no message
 * content kept. Agent feeds it where each fact already happens and writes `record()` to the
 * session jsonl once, at session end. Nothing renders it until ten sessions of baseline exist.
 * Permission prompts are credited through AsyncLocalStorage: chat() runs the turn inside
 * withFriction, so a prompt belongs to the turn whose async chain asked, however turns interleave.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const OPENERS = new Set(["no", "not", "wrong", "actually", "instead"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);

/**
 * Correction, precisely: (a) the first word (lowercased, letters only) is no, not, wrong,
 * actually or instead; or (b) it began within 60 s of the previous reply finishing and shares
 * at least 60% of its 3+ letter words (Jaccard) with the previous prompt, both having 3+ such
 * words. A session's first prompt is never a correction.
 */
export function isCorrection(
	text: string,
	prev: { text: string; endedAt: number | null } | null,
	now: number,
): boolean {
	if (!prev) return false;
	if (
		OPENERS.has(
			text
				.trim()
				.toLowerCase()
				.match(/^[a-z]+/)?.[0] ?? "",
		)
	)
		return true;
	if (prev.endedAt === null || now - prev.endedAt > 60_000) return false;
	const [a, b] = [words(text), words(prev.text)];
	if (a.size < 3 || b.size < 3) return false;
	const shared = [...a].filter((w) => b.has(w)).length;
	return shared / (a.size + b.size - shared) >= 0.6;
}

const COUNTS = [
	"prompts",
	"toolCalls",
	"toolErrors",
	"retries",
	"permissionPrompts",
	"permissionDenials",
	"honestyNudges",
	"testClaimNudges",
	"corrections",
] as const;
export type FrictionCount = (typeof COUNTS)[number];
export type FrictionRecord = {
	type: "friction";
	turnSecondsP50: number;
	turnSecondsMax: number;
} & Record<FrictionCount, number>;

export class Friction {
	private c = Object.fromEntries(COUNTS.map((k) => [k, 0])) as Record<FrictionCount, number>;
	private turns: number[] = [];
	private start: number | null = null;
	private prev: { text: string; endedAt: number | null } | null = null;

	count(k: FrictionCount): void {
		this.c[k]++;
	}
	prompt(text: string, now = Date.now()): void {
		if (isCorrection(text, this.prev, now)) this.c.corrections++;
		this.c.prompts++;
		this.start = now;
		this.prev = { text, endedAt: null };
	}
	turnEnd(now = Date.now()): void {
		if (this.start !== null) this.turns.push((now - this.start) / 1000);
		this.start = null;
		if (this.prev) this.prev.endedAt = now;
	}
	tool(success: boolean): void {
		this.c.toolCalls++;
		if (!success) this.c.toolErrors++;
	}
	/** A permission prompt was shown; "deny" is a denial. */
	permission(decision: string): void {
		this.c.permissionPrompts++;
		if (decision === "deny") this.c.permissionDenials++;
	}
	record(): FrictionRecord {
		const t = [...this.turns].sort((x, y) => x - y);
		const r = (n: number) => Math.round(n * 10) / 10;
		return {
			type: "friction",
			...this.c,
			turnSecondsP50: r(t[Math.ceil(t.length / 2) - 1] ?? 0),
			turnSecondsMax: r(t[t.length - 1] ?? 0),
		};
	}
}

const turnFriction = new AsyncLocalStorage<Friction>();
/** Run one turn with `f` as the tracker that approval prompts asked inside it are counted to. */
export const withFriction = <T>(f: Friction, fn: () => T): T => turnFriction.run(f, fn);
/** Only prompts a person was shown count: approve, deny, edit (not skip or unfit); none outside a turn. */
export const noteApproval = (decision: string): void => {
	if (["approve", "deny", "edit"].includes(decision)) turnFriction.getStore()?.permission(decision);
};
