/**
 * Per-turn limits that hold in every mode (#4982).
 *
 * A spoken "I just wanted to hear the voice TTS" ran 111 tool calls in Infinite
 * mode: the silent-calls guard (silent-calls.ts) only reports every 24 calls
 * there and never stops, every call returned something so the useless-streak
 * guard stayed quiet, seven calls were refused by System One and nothing counted
 * them, and the context grew past a million tokens. The person waited ten
 * minutes for a sentence.
 *
 * Three deterministic stops, checked after every round, no model asked:
 *   - tool-call cap     EIGHT_TURN_TOOL_CAP  default 48, 0 = off
 *   - refused calls     EIGHT_TURN_BLOCKS    default 3,  0 = off
 *   - context growth    EIGHT_TURN_TOKENS    default half the model's context window
 *                                            (needs a known window), 0 = off
 *
 * Why a hard cap and not "make 24 a real stop in Infinite": the 24-call progress
 * line stays, so a long, healthy Infinite run keeps its progress reports, and one
 * counter that ignores prose, mode and the silent-calls state is the smallest rule
 * that bounds every turn. Each stop is one plain line, and the next message
 * ("continue") starts a fresh budget.
 */

export const DEFAULT_TURN_TOOL_CAP = 48;
export const DEFAULT_TURN_BLOCKS = 3;

export interface TurnLimits {
	/** Tool calls in one turn before it ends; 0 = off. */
	toolCap: number;
	/** Calls refused by System One or a hook before the turn ends; 0 = off. */
	blocks: number;
	/** Tokens the turn may add to the context before it ends; 0 = off. */
	tokens: number;
	/**
	 * Redacts secrets from text that goes into the stop line (injected by the
	 * caller, so this file imports nothing from eight/). Unset: text is kept.
	 */
	scrub?: (text: string) => string;
}

type Env = Record<string, string | undefined>;

function nonNegInt(raw: string | undefined, fallback: number): number {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "") return fallback;
	if (v === "off" || v === "false") return 0;
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function resolveTurnToolCap(env: Env = process.env): number {
	return nonNegInt(env.EIGHT_TURN_TOOL_CAP, DEFAULT_TURN_TOOL_CAP);
}

export function resolveTurnBlocks(env: Env = process.env): number {
	return nonNegInt(env.EIGHT_TURN_BLOCKS, DEFAULT_TURN_BLOCKS);
}

/** EIGHT_TURN_TOKENS wins; else half the context window; unknown window = off. */
export function resolveTurnTokens(contextWindow: number, env: Env = process.env): number {
	const override = nonNegInt(env.EIGHT_TURN_TOKENS, -1);
	if (override >= 0) return override;
	return contextWindow > 0 ? Math.floor(contextWindow / 2) : 0;
}

export function resolveTurnLimits(
	contextWindow: number,
	env: Env = process.env,
	scrub?: (text: string) => string,
): TurnLimits {
	return {
		toolCap: resolveTurnToolCap(env),
		blocks: resolveTurnBlocks(env),
		tokens: resolveTurnTokens(contextWindow, env),
		...(scrub ? { scrub } : {}),
	};
}

/** Commands and reasons that touch credential files: the stop line names the tool only. */
const SENSITIVE =
	/(?:^|[\s'"=:/~])(?:\.env\b|\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.npmrc|\.netrc|\.gnupg|\.pem\b|\.p12\b|\.keychain|credentials?\b|secrets?\b)/i;

/** What the guard needs to know about one tool call. */
export interface GuardCall {
	name: string;
	/** The command text for run_command, else a short argument summary. */
	detail?: string;
	/** Why the call was refused (System One, a hook), or null when it ran. */
	blockedReason?: string | null;
}

export interface GuardRound {
	calls: GuardCall[];
	/** Context size after this round (prompt plus reply), when the provider reported it. */
	contextTokens?: number;
	/** Context size going into the turn's first round. */
	startTokens?: number;
}

const short = (s: string, n: number) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 3)}...` : one;
};

export class TurnGuard {
	calls = 0;
	private tried: string[] = [];
	private blocked: { what: string; reason: string }[] = [];
	/** Refused calls since the last call that ran. */
	private refusedRun = 0;
	private refusedByCommand = new Map<string, number>();
	private repeatRefused = false;
	private startTokens: number | undefined;
	private lastTokens = 0;
	private line: string | null = null;

	constructor(private readonly limits: TurnLimits) {}

	round(r: GuardRound): void {
		for (const c of r.calls) {
			this.calls++;
			if (!this.tried.includes(c.name)) this.tried.push(c.name);
			if (c.blockedReason == null) {
				this.refusedRun = 0;
				this.blocked = [];
				this.refusedByCommand.clear();
				this.repeatRefused = false;
			} else {
				this.refusedRun++;
				const key = `${c.name}\u0000${c.detail ?? ""}`;
				const seen = (this.refusedByCommand.get(key) ?? 0) + 1;
				this.refusedByCommand.set(key, seen);
				if (seen >= 2) this.repeatRefused = true;
				const clean = (t: string) => this.limits.scrub?.(t) ?? t;
				const touchesSecrets = SENSITIVE.test(`${c.detail ?? ""} ${c.blockedReason}`);
				this.blocked.push({
					what: touchesSecrets ? c.name : short(clean(c.detail || c.name), 60),
					reason: touchesSecrets
						? "it touched a protected path"
						: short(clean(c.blockedReason), 80),
				});
			}
		}
		if (this.startTokens === undefined && r.startTokens !== undefined) {
			this.startTokens = r.startTokens;
		}
		if (r.contextTokens !== undefined) this.lastTokens = r.contextTokens;
	}

	/** The plain line that ends the turn, or null while the turn is within its limits. Sticky. */
	stop(): string | null {
		if (this.line) return this.line;
		const { toolCap, blocks, tokens } = this.limits;
		if (blocks > 0 && (this.refusedRun >= blocks || this.repeatRefused)) {
			const cmds = this.blocked.map((b) => b.what);
			const why = [...new Set(this.blocked.map((b) => b.reason))].join("; ");
			this.line = `Stopped: ${this.blocked.length} tool calls in a row were refused (${cmds.join("; ")}) because ${why}. What would you like me to do instead?`;
		} else if (tokens > 0 && this.grown() >= tokens) {
			this.line = `Stopped: this turn has added ${this.grown()} tokens to the context (limit ${tokens}, set with EIGHT_TURN_TOKENS). Keep going?`;
		} else if (toolCap > 0 && this.calls >= toolCap) {
			this.line = `Stopped after ${this.calls} tool calls (${this.tried.join(", ")}). Say "continue" to keep going, or raise the limit with EIGHT_TURN_TOOL_CAP (0 turns it off).`;
		}
		return this.line;
	}

	private grown(): number {
		// No input count for the first round: growth is unknown, so it never trips.
		if (this.startTokens === undefined) return 0;
		return Math.max(0, this.lastTokens - this.startTokens);
	}
}

/** The shape of an AI SDK step this file reads. */
export interface GuardStep {
	toolCalls?: ReadonlyArray<{
		toolName?: string;
		toolCallId?: string;
		input?: unknown;
		args?: unknown;
	}>;
	toolResults?: ReadonlyArray<{ toolCallId?: string; output?: unknown; result?: unknown }>;
	content?: ReadonlyArray<{
		type?: string;
		toolCallId?: string;
		toolName?: string;
		error?: unknown;
	}>;
	usage?: { inputTokens?: number; totalTokens?: number; promptTokens?: number };
}

/**
 * The refusal reason inside a "[... BLOCKED]" tool result, or null. Two results
 * that look like refusals are not counted here:
 *  - a run_command refused for chaining: #3409 agreed these do not stop a turn,
 *    the model learns to send one command per call (its own ceiling of 100 holds);
 *  - a bare "[BLOCKED]" line with none of the gate's structure (Reason:, Command:,
 *    "Nothing was sent"): that is a command that ran and printed the marker.
 */
export function blockedReasonOf(result: unknown): string | null {
	if (typeof result !== "string") return null;
	// Judged on the text before the gate echoes the command (" Command:"), so a command
	// that merely contains these words is still counted.
	const head = result.split(/\s+Command:/)[0];
	if (/^\s*\[BLOCKED\][^\n]*\bcommand chaining\b[^\n]*\bis not allowed\b/i.test(head)) return null;
	const m = /^\s*(\[[^\]\n]*\bBLOCKED\b[^\]\n]*\])\s*([\s\S]*)$/i.exec(result);
	if (!m) return null;
	const body = m[2].trim();
	const bare = m[1].trim().toUpperCase() === "[BLOCKED]";
	if (bare && !/\b(?:Reason:|Command:|Nothing was sent)/.test(body)) return null;
	const field = /\bReason:\s*([\s\S]*?)(?:\s+Alternative:[\s\S]*)?$/.exec(body);
	const reason = (field ? field[1] : body.split(/\s+Command:/)[0]).split(/\.(?:\s|$)/)[0];
	return reason.replace(/\s+/g, " ").trim() || "blocked";
}

function detailOf(input: unknown): string | undefined {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		for (const k of ["command", "path", "url", "query"]) {
			if (typeof o[k] === "string") return o[k] as string;
		}
	}
	return undefined;
}

/**
 * The stop line for a native-loop run so far (stateless: it reads every finished
 * step), or null. A call counts as refused when its tool threw ToolCallRefused
 * (the permission gate) or its result starts with a "[... BLOCKED]" gate prefix.
 */
export function turnStopForSteps(
	steps: ReadonlyArray<GuardStep>,
	limits: TurnLimits,
): string | null {
	const guard = new TurnGuard(limits);
	steps.forEach((s, i) => {
		const refused = new Map<string, string>();
		for (const part of s.content ?? []) {
			if (part.type === "tool-error" && part.toolCallId) {
				const e = part.error as { name?: string; message?: string } | undefined;
				if (e?.name === "ToolCallRefused") refused.set(part.toolCallId, e.message ?? "refused");
			}
		}
		for (const r of s.toolResults ?? []) {
			const why = blockedReasonOf(r.output ?? r.result);
			if (why !== null && r.toolCallId) refused.set(r.toolCallId, why);
		}
		const u = s.usage;
		guard.round({
			calls: (s.toolCalls ?? []).map((c) => ({
				name: c.toolName ?? "tool",
				detail: detailOf(c.input ?? c.args),
				blockedReason: c.toolCallId ? (refused.get(c.toolCallId) ?? null) : null,
			})),
			contextTokens: u?.totalTokens || undefined,
			startTokens: i === 0 ? u?.inputTokens || u?.promptTokens || undefined : undefined,
		});
	});
	return guard.stop();
}
