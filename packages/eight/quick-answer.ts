/**
 * Quick-answer fast lane (#3411).
 *
 * Classify a prompt on arrival as quick, deep or unclear. A quick prompt (a short
 * question with no instruction in it) is first answered by a bounded, read-only
 * run of the text-tool loop: at most QUICK_MAX_TOOL_CALLS tool calls and
 * QUICK_BUDGET_MS of wall clock. Anything else, or a quick run that misses its
 * budget, goes through the normal loop unchanged. Off unless EIGHT_QUICK_ANSWER=1.
 */

import { type TextTool, type TextToolAgentResult, type ToolSpec, runTextToolAgent } from "../ai";
import type { TextToolCall, TextToolMessage } from "../ai/text-tool-client";

export type PromptClass = "quick" | "deep" | "unclear";

export const QUICK_MAX_TOOL_CALLS = 3;
export const QUICK_BUDGET_MS = 15_000;
export const QUICK_MAX_WORDS = 60;
export const QUICK_LABEL = "Quick answer:";
export const NEEDS_DEEP = "NEEDS_DEEP";

/** Read-only tools the lane may use. Every one is inside the conv-quick-answer judge allowlist. */
export const QUICK_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"list_files",
	"get_outline",
	"get_symbol",
	"search_symbols",
	"locate",
]);

/**
 * Question shape, byte-identical to QUESTION in ~/.8gent/bin/sovereignty-index (code_question),
 * so the index and the product agree on what a question looks like. Applied to lowercased text.
 */
export const QUESTION =
	/\?|^\s*(what|which|where|when|who|whose|why|how|is|are|was|were|does|do|did|can|could|should|would|will|has|have)\b/;

/** Verbs that make a clause an instruction when they open it. */
const ACTION_VERBS = new Set(
	`fix add change edit update write rewrite create build implement refactor rename delete remove
	move run rerun install uninstall deploy push merge land commit ship make wire migrate open close
	file draft generate replace patch bump release start stop restart kill clean cleanup revert
	rollback reset rebase apply configure enable disable set setup upgrade downgrade publish send
	post schedule launch investigate research review audit debug compare analyse analyze profile
	benchmark test retry rebuild document port scaffold convert format lint refresh sync record
	render design plan look dig finish continue resume proceed go use try keep sort split`.split(
		/\s+/,
	),
);

/** "do" is an instruction only before an object ("do it"), never as "do we/you/I". */
const DO_OBJECT = /^do\s+(it|that|this|the|so|both|all|them|those|these)\b/;

/** Reassurances that name a verb without asking for it. */
const NEGATED_ACTION =
	/\b(no need to|don'?t|do not|never|without|not)\s+(\w+)(\s+(anything|it|that|this|them|a thing))?/g;

/** Leading words that sit in front of an instruction's verb. */
const REQUEST_FILLER =
	/^(please|pls|ok(ay)?|so|now|just|also|then|and|but|hey|right|eight|8gent|go ahead and|can you|could you|would you|will you|can u|i want you to|i need you to|i'?d like you to|let'?s|lets|you should|you need to|we should|we need to|need to|to)\b\s*/;

const STOPWORDS = new Set(
	`a an the and or but if then so of to in on at by for with about from this that these those it
	its it's that's this one ones i me my we us our you your he she they them their what which where
	when who whose why how is are was were does do did can could should would will has have be been
	any some there here again more else too also just about`.split(/\s+/),
);

function clauses(text: string): string[] {
	return text
		.split(/[.!?;:\n]+|,\s*|\s+(?:and then|and|then|so|but)\s+/)
		.map((c) => c.trim())
		.filter(Boolean);
}

function opensWithAction(clause: string): boolean {
	let c = clause;
	for (let prev = ""; prev !== c; ) {
		prev = c;
		c = c.replace(REQUEST_FILLER, "");
	}
	if (DO_OBJECT.test(c)) return true;
	const first = c.split(/\s+/)[0]?.replace(/[^a-z-]/g, "") ?? "";
	return ACTION_VERBS.has(first);
}

/** Deterministic classifier. Same input, same class. */
export function classifyPrompt(raw: string): PromptClass {
	const text = raw.trim().toLowerCase();
	if (!text) return "unclear";
	const asked = text.replace(NEGATED_ACTION, " ");
	if (clauses(asked).some(opensWithAction)) return "deep";
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length > QUICK_MAX_WORDS) return "deep";
	if (QUESTION.test(text)) {
		const content = words
			.map((w) => w.replace(/[^a-z0-9_#./-]/g, ""))
			.filter((w) => w && !STOPWORDS.has(w));
		return content.length === 0 ? "unclear" : "quick";
	}
	return words.length <= 2 ? "unclear" : "deep";
}

export function quickLaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_QUICK_ANSWER === "1";
}

export const QUICK_INSTRUCTION = [
	"[QUICK ANSWER] This is a quick question. Answer it directly and briefly from the source.",
	`You may use at most ${QUICK_MAX_TOOL_CALLS} read-only tool calls. Do not change anything.`,
	`Start your answer with "DONE:". If you cannot answer within that budget, reply with exactly ${NEEDS_DEEP}.`,
].join("\n");

export type QuickOutcome =
	| { ok: true; result: TextToolAgentResult; ms: number }
	| { ok: false; reason: string; ms: number };

export interface QuickLaneOptions {
	/** The turn's conversation, ending with the user's prompt. Not mutated. */
	messages: TextToolMessage[];
	/** The session's tools; only QUICK_TOOLS are kept. */
	tools: TextTool[];
	/** Builds the model call for this lane, wired to the given signal and timeout, declaring only `specs`. */
	makeCall: (signal: AbortSignal, timeoutMs: number, specs: ToolSpec[]) => TextToolCall;
	/** The turn's own signal (ESC). Aborting it aborts the lane. */
	signal?: AbortSignal;
	budgetMs?: number;
	maxToolCalls?: number;
	now?: () => number;
}

/**
 * Run the bounded read-only lane. Returns ok only for a complete answer inside budget; every
 * other outcome carries the reason and the caller runs the normal loop.
 */
export async function runQuickAnswer(opts: QuickLaneOptions): Promise<QuickOutcome> {
	const now = opts.now ?? Date.now;
	const budgetMs = opts.budgetMs ?? QUICK_BUDGET_MS;
	const maxCalls = opts.maxToolCalls ?? QUICK_MAX_TOOL_CALLS;
	const started = now();
	const elapsed = () => now() - started;
	const ac = new AbortController();
	const onOuterAbort = () => ac.abort();
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
	if (opts.signal?.aborted) ac.abort();
	const timer = setTimeout(() => ac.abort(), budgetMs);

	let calls = 0;
	let overBudget = false;
	const tools: TextTool[] = opts.tools
		.filter((t) => QUICK_TOOLS.has(t.spec.name))
		.map((t) => ({
			spec: t.spec,
			run: async (args: Record<string, unknown>) => {
				if (calls >= maxCalls) {
					overBudget = true;
					return `Tool budget for a quick answer is used up (${maxCalls} calls). Answer now from what you have, or reply ${NEEDS_DEEP}.`;
				}
				calls++;
				return t.run(args);
			},
		}));

	const baseCall = opts.makeCall(
		ac.signal,
		budgetMs,
		tools.map((t) => t.spec),
	);
	const call: TextToolCall = (msgs) => {
		const left = budgetMs - elapsed();
		if (left <= 0 || ac.signal.aborted) {
			ac.abort();
			return Promise.reject(new Error("quick lane budget elapsed"));
		}
		return baseCall(msgs);
	};

	try {
		const result = await runTextToolAgent({
			messages: [...opts.messages, { role: "user", content: QUICK_INSTRUCTION }],
			tools,
			call,
			maxRounds: maxCalls + 1,
			signal: ac.signal,
		});
		const ms = elapsed();
		const text = result.content.trim();
		if (opts.signal?.aborted) return { ok: false, reason: "aborted", ms };
		if (ac.signal.aborted || ms > budgetMs) return { ok: false, reason: `over ${budgetMs} ms`, ms };
		if (!text) return { ok: false, reason: "empty answer", ms };
		if (text.includes(NEEDS_DEEP))
			return { ok: false, reason: "model asked for the full loop", ms };
		if (result.unverified.length > 0) return { ok: false, reason: "unverified claims", ms };
		if (overBudget) {
			// It asked for tools past the budget: the question needs the full loop.
			return { ok: false, reason: `tool budget of ${maxCalls} calls exceeded`, ms };
		}
		return { ok: true, result: { ...result, content: `${QUICK_LABEL} ${text}` }, ms };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: ac.signal.aborted ? `over ${budgetMs} ms` : msg, ms: elapsed() };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}
