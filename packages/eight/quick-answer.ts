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
import { cutOffToolCallMessage, isEmptyReplyStall } from "../ai/text-tool-loop";

export type PromptClass = "quick" | "deep" | "unclear";

export const QUICK_MAX_TOOL_CALLS = 3;
export const QUICK_BUDGET_MS = 15_000;
export const QUICK_MAX_WORDS = 60;
/** Shown on the provisional answer, which the full answer always follows and checks (#3416). */
export const QUICK_LABEL = "Quick answer (still checking):";
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
	render design plan look dig finish continue resume proceed go use try keep sort split
	verify ping notify message handle get git`.split(/\s+/),
);

/** "do" is an instruction only before an object ("do it"), never as "do we/you/I". */
const DO_OBJECT = /^do\s+(it|that|this|the|so|both|all|them|those|these)\b/;

/**
 * Verbs that are instructions only in one shape (8PO review, round 2):
 * "tell Rishi" / "let Kevin know" (not "tell me", "let me know": the answer is the telling),
 * "take care of", and causative "have the officers review" (not "have you pushed it?").
 */
const SHAPED_ACTION =
	/^(tell\s+(?!me\b|us\b)\S+|let\s+(?!me\b|us\b)\S+(\s+\S+)?\s+know\b|take\s+care\s+of\b|have\s+(?!you\b|we\b|they\b|i\b|it\b|he\b|she\b|there\b|any\w*\b|been\b)\S+)/;

/** Discussion openers: judgement questions three file reads cannot answer. */
const DISCUSSION =
	/\b(what do you think|how should we|how would you approach|i want to understand|what'?s your (view|take|opinion))\b/;

/**
 * Reassurances that name a verb without asking for it. Never after "if" / "unless":
 * "if not restart it" is a conditional instruction, not a reassurance.
 */
const NEGATED_ACTION =
	/(?<!\b(?:if|unless)\s+)\b(no need to|don'?t|do not|never|without|not)(?!\s+(?:you|we)\b)\s+(\w+)(\s+(anything|it|that|this|them|a thing))?/g;

/** Leading words that sit in front of an instruction's verb. */
const REQUEST_FILLER =
	/^(please|pls|ok(ay)?|so|now|just|also|then|and|but|hey|right|eight|8gent|go ahead and|can you|could you|would you|will you|can u|i want you to|i need you to|i'?d like you to|let'?s|lets|you should|you need to|we should|we need to|need to|to|can we|could we|if not|if so|if yes|if it is|if it'?s not|otherwise|else|unless|why don'?t you|why don'?t we|why not|how about you)\b\s*/;

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
	if (DO_OBJECT.test(c) || SHAPED_ACTION.test(c)) return true;
	const first = c.split(/\s+/)[0]?.replace(/[^a-z-]/g, "") ?? "";
	return ACTION_VERBS.has(first);
}

function contentWords(words: string[]): string[] {
	return words.map((w) => w.replace(/[^a-z0-9_#./-]/g, "")).filter((w) => w && !STOPWORDS.has(w));
}

// ── Context-dependent short questions (#3416, design R2.3 and R3.4) ───────
// A follow-up such as "which port?" or "and on staging?" means something only
// against the conversation, which the lane never sees. Those go to the full loop.

/** S2, S4, (b) and (c) apply only to messages this short. */
export const CONTEXT_MAX_WORDS = 12;

/** S1: a continuation opener at the start of the message, after "ok", "okay" or "right". */
const CONTINUATION =
	/^(?:(?:ok|okay|right)\b[\s,.!]*)*(?:and|or|but|also|so|then|what about|how about|same for)\b/;
/** S2: "it" or "that" as the subject, at the start or straight after an auxiliary. */
const IT_SUBJECT =
	/^(?:it|that)\b|\b(?:is|was|are|were|does|did|has|have|can|could|will|would|should) (?:it|that)\b/;
/** S3: a question about the agent's own past turn ("what did you" is covered by "did you"). */
const ABOUT_PAST_TURN = /\b(?:did you|have you|are you|you said)\b/;
/** S4: session state the lane's read-only file tools cannot read. */
const SESSION_STATE =
	/\b(?:the logs|the diff|the output|the error|the build|git status|the last run)\b/;
/** (b): a back-reference, once the phrases that name something in the repo are taken out. */
const BACK_REFERENCE =
	/\b(?:it|that|this|those|there|the other one|that one|the same|the (?:first|second|last) one)\b/;
const NOT_A_BACK_REFERENCE =
	/\b(?:this|the) (?:repo|project|codebase|branch)\b|\b(?:is|are) there\b/g;

/** Longest token the anchor scan looks at: keeps every per-token test linear. */
const ANCHOR_TOKEN_MAX = 100;
const QUOTED_LITERAL =
	/"[^"\n]{1,200}"|`[^`\n]{1,200}`|(?:^|[\s(])'[^'\s][^'\n]{0,198}'(?=$|[\s).,?!:;])/;

/**
 * An anchor names something concrete: a path-like token, a quoted or backticked literal, a
 * camelCase, snake_case or ALL_CAPS identifier, a call `name()`, or a number. Read on the raw
 * text, because lowercasing erases camelCase and ALL_CAPS.
 */
export function hasAnchor(raw: string): boolean {
	if (QUOTED_LITERAL.test(raw)) return true;
	for (const full of raw.split(/\s+/)) {
		const t = full.slice(0, ANCHOR_TOKEN_MAX);
		if (!t) continue;
		if (
			t.includes("/") ||
			/\d/.test(t) ||
			/\w\(\)/.test(t) ||
			/[A-Za-z0-9-]\.[A-Za-z][A-Za-z0-9]{0,7}\b/.test(t) ||
			/\b[a-z][a-z0-9]*[A-Z]/.test(t) ||
			/[A-Za-z0-9]_[A-Za-z0-9]/.test(t) ||
			/\b[A-Z][A-Z0-9_]{2,}\b/.test(t)
		)
			return true;
	}
	return false;
}

type ContextRule = "S1" | "S2" | "S3" | "S4" | "b" | "c";

/** Which context rule sends this prompt to the full loop, if any. Pure. */
export function contextRule(raw: string): ContextRule | null {
	const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
	if (!text) return null;
	// S1 and S3 apply at any length (R3.4).
	if (CONTINUATION.test(text)) return "S1";
	if (ABOUT_PAST_TURN.test(text)) return "S3";
	const words = text.split(" ");
	if (words.length > CONTEXT_MAX_WORDS) return null;
	if (IT_SUBJECT.test(text)) return "S2";
	if (SESSION_STATE.test(text)) return "S4";
	if (hasAnchor(raw)) return null;
	if (BACK_REFERENCE.test(text.replace(NOT_A_BACK_REFERENCE, " "))) return "b";
	if (contentWords(words).length < 2) return "c";
	return null;
}

/** True when the prompt only makes sense against the earlier conversation. */
export function isContextDependent(raw: string): boolean {
	return contextRule(raw) !== null;
}

function classify(raw: string): { cls: PromptClass; context: boolean } {
	const text = raw.trim().toLowerCase();
	if (!text) return { cls: "unclear", context: false };
	const asked = text.replace(NEGATED_ACTION, " ");
	if (clauses(asked).some(opensWithAction)) return { cls: "deep", context: false };
	if (DISCUSSION.test(text)) return { cls: "deep", context: false };
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length > QUICK_MAX_WORDS) return { cls: "deep", context: false };
	if (QUESTION.test(text)) {
		const rule = contextRule(raw);
		if (contentWords(words).length === 0) {
			// Zero content words stays unclear (PR1), so a first "why?" can still be asked
			// about. "it"/"that" as subject or a question about our own turn is a follow-up.
			return rule === "S2" || rule === "S3"
				? { cls: "deep", context: true }
				: { cls: "unclear", context: false };
		}
		return rule ? { cls: "deep", context: true } : { cls: "quick", context: false };
	}
	return { cls: words.length <= 2 ? "unclear" : "deep", context: false };
}

/** Deterministic classifier. Same input, same class. */
export function classifyPrompt(raw: string): PromptClass {
	return classify(raw).cls;
}

/** True when the context rule (not an instruction) made this prompt deep. For the run log. */
export function promptNeedsContext(raw: string): boolean {
	return classify(raw).context;
}

/**
 * The one question asked instead of answering: an unclear first message, nothing to
 * resolve it against (#3416, section 3). Fixed text, no model call.
 */
export const CLARIFY_QUESTION =
	"Quick question first: what do you want me to look into? A file, a command or a feature name is enough.";

/**
 * Small local models the lane prefers over the session model when EIGHT_QUICK_MODEL is unset.
 * On the 27B session model the lane timed out at 15 s (A/B run 2026-10-03_214455).
 */
export const QUICK_MODEL_PREFERENCE: readonly string[] = ["qwen3.5:9b"];

export type QuickModelPick = { model: string; source: "env" | "preferred" | "session" };

/** EIGHT_QUICK_MODEL wins; else the first preferred model installed on the session's provider; else the session model. */
export function pickQuickModel(opts: {
	envModel?: string;
	sessionModel: string;
	installed: readonly string[];
}): QuickModelPick {
	const env = opts.envModel?.trim();
	if (env) return { model: env, source: "env" };
	const have = opts.installed.map((m) => m.toLowerCase());
	for (const want of QUICK_MODEL_PREFERENCE) {
		// Exact name only: a "-cloud" tag is forwarded off the machine by Ollama (8SO Q-L1).
		const i = have.findIndex((m) => m === want);
		if (i >= 0) return { model: opts.installed[i], source: "preferred" };
	}
	return { model: opts.sessionModel, source: "session" };
}

let installedCache: Promise<Array<{ provider: string; model: string }>> | null = null;

/** Models installed on `provider`, detected once per process (each probe is time-bounded). */
export async function installedModelsFor(provider: string): Promise<string[]> {
	installedCache ??= import("../orchestration/local-model-detect")
		.then((m) => m.detectLocalModels())
		.catch(() => []);
	const all = await installedCache;
	return all.filter((m) => m.provider === provider).map((m) => m.model);
}

export function quickLaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_QUICK_ANSWER === "1";
}

export const QUICK_INSTRUCTION = [
	"[QUICK ANSWER] This is a quick question. Answer it directly and briefly from the source.",
	`You may use at most ${QUICK_MAX_TOOL_CALLS} read-only tool calls. Do not change anything.`,
	"Read the files you need together: put several tool_call blocks in one reply.",
	`Start your answer with "DONE:". If you cannot answer within that budget, reply with exactly ${NEEDS_DEEP}.`,
	`If the message also asks you to do, change, send or check something you cannot do with read-only tools, reply with exactly ${NEEDS_DEEP}.`,
].join("\n");

/**
 * The lane's own system prompt (round 4). Prompt processing on the 9B runs at about 400
 * tokens/s, so the full agent prompt (tens of thousands of chars) alone used the 15 s budget.
 */
export function quickSystemPrompt(cwd: string): string {
	return [
		"You are 8gent, answering a quick question about the code in this working directory.",
		`Working directory: ${cwd}`,
		"You can read files but not change anything.",
		"Answer in a sentence or two of plain text. If the user asks for an exact output format, follow it exactly.",
	].join("\n");
}

/** The lane's whole conversation: its system prompt and the user's message. No history. */
export function quickMessages(cwd: string, prompt: string): TextToolMessage[] {
	return [
		{ role: "system", content: quickSystemPrompt(cwd) },
		{ role: "user", content: prompt },
	];
}

/** A tool spec cut down for the lane: first sentence of the description (90 chars), param types only. */
export function compactSpec(spec: ToolSpec): ToolSpec {
	const text = (spec.description ?? "").replace(/^\s*\[[A-Z]+\]\s*/, "");
	const first = text.split(/(?<=\.)\s|\n/)[0]?.trim() ?? "";
	const description = first.length > 90 ? `${first.slice(0, 87)}...` : first;
	const params = (spec.parameters ?? {}) as {
		properties?: Record<string, { type?: unknown; enum?: unknown }>;
		required?: unknown;
	};
	const properties: Record<string, { type?: unknown; enum?: unknown }> = {};
	for (const [name, node] of Object.entries(params.properties ?? {})) {
		properties[name] = {
			...(node?.type !== undefined ? { type: node.type } : {}),
			...(Array.isArray(node?.enum) ? { enum: node.enum } : {}),
		};
	}
	return {
		...spec,
		description,
		parameters: {
			type: "object",
			properties,
			...(Array.isArray(params.required) ? { required: params.required } : {}),
		},
	};
}

/** The lane's tool instructions: the same fenced tool_call protocol, in a few lines. */
export function quickToolPrompt(tools: ToolSpec[]): string {
	const lines = tools.map((t) => {
		const p = (t.parameters ?? {}) as {
			properties?: Record<string, { type?: unknown }>;
			required?: unknown;
		};
		const req = new Set(Array.isArray(p.required) ? (p.required as string[]) : []);
		const args = Object.entries(p.properties ?? {})
			.map(
				([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeof v?.type === "string" ? v.type : "any"}`,
			)
			.join(", ");
		return `- ${t.name}(${args}) - ${t.description}`;
	});
	return [
		"To call a tool, reply with ONLY a fenced block like this, nothing else:",
		"```tool_call",
		'{"name": "read_file", "arguments": {"path": "src/server.ts"}}',
		"```",
		"You may put several tool_call blocks in one reply; they all run.",
		"The results come back to you. Never guess what a file says: read it first.",
		"A reply with no tool_call block is your final answer.",
		"Tools:",
		...lines,
	].join("\n");
}

/**
 * A reply that says it has no answer is not a quick answer, whatever it is labelled
 * (round 5 repro: "Since I haven't read it yet, I cannot give an accurate answer").
 */
export const NON_ANSWER =
	/\b(cannot|can'?t|could ?n[o']t|unable to|not able to) (give|provide|answer|determine|tell|say|confirm)\b|\bhaven'?t (read|seen|checked)\b|\bwithout (reading|checking|seeing)\b|\bI (would |still )?need to (read|check|look|see|find|search)\b|\blet me (search|check|read|look|find|try)\b/i;

/** Tool-call markup left in the prose: a call the parser did not take, not an answer (round 5 repro). */
export const LEFTOVER_CALL =
	/\{\s*"name"\s*:\s*"\w+"\s*,\s*"arguments"\s*:|\{\s*"arguments"\s*:[\s\S]{0,400}?"name"\s*:\s*"\w+"|```tool_call|<tool_call>[\s\S]*?<\/tool_call>/;

/**
 * The loop's note for a tool call cut off in the last round: the same for every tool name. A
 * cut-off call is markup, not an answer (round 6: it was shown as "Quick answer: Error: ...").
 */
const CUT_OFF_CALL = cutOffToolCallMessage(null).slice(
	cutOffToolCallMessage(null).indexOf(" was cut off"),
);

const BUDGET_ELAPSED = "The quick-answer time budget elapsed before this read finished.";

/**
 * The lane instruction rides on the user's own message, not as a turn of its own, so the
 * loop's claim check still reads the user's words as the request (8SO F2).
 */
function withInstruction(messages: TextToolMessage[]): TextToolMessage[] {
	const out = messages.slice();
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i].role === "user") {
			out[i] = { ...out[i], content: `${out[i].content}\n\n${QUICK_INSTRUCTION}` };
			return out;
		}
	}
	return [...out, { role: "user", content: QUICK_INSTRUCTION }];
}

export type QuickOutcome =
	| { ok: true; result: TextToolAgentResult; answer: string; ms: number; tools: number }
	| { ok: false; reason: string; ms: number; tools: number; claims?: string[] };

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
	const tools: TextTool[] = opts.tools
		.filter((t) => QUICK_TOOLS.has(t.spec.name))
		.map((t) => ({
			spec: compactSpec(t.spec),
			run: async (args: Record<string, unknown>) => {
				if (calls >= maxCalls) {
					return `Tool budget for a quick answer is used up (${maxCalls} calls). Answer now from what you have, or reply ${NEEDS_DEEP}.`;
				}
				calls++;
				// The budget is a hard wall for a running tool too (8SO F3): a read that
				// outlives it finishes in the background, as in the normal loop.
				return Promise.race([
					t.run(args),
					new Promise<string>((resolve) => {
						if (ac.signal.aborted) resolve(BUDGET_ELAPSED);
						ac.signal.addEventListener("abort", () => resolve(BUDGET_ELAPSED), { once: true });
					}),
				]);
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
			messages: withInstruction(opts.messages),
			tools,
			call,
			// One round past the call budget, so a model told "budget used" can still answer
			// (round 5: qwen3.5:9b spent all 4 rounds on calls and never answered).
			maxRounds: maxCalls + 2,
			signal: ac.signal,
			toolPrompt: quickToolPrompt,
		});
		const ms = elapsed();
		const text = result.content.trim();
		if (opts.signal?.aborted) return { ok: false, reason: "aborted", ms, tools: calls };
		if (ac.signal.aborted || ms > budgetMs)
			return { ok: false, reason: `over ${budgetMs} ms`, ms, tools: calls };
		if (!text) return { ok: false, reason: "empty answer", ms, tools: calls };
		if (LEFTOVER_CALL.test(text) || text.includes(CUT_OFF_CALL))
			return { ok: false, reason: "tool-call markup in the answer", ms, tools: calls };
		if (NON_ANSWER.test(text))
			return { ok: false, reason: "model said it could not answer", ms, tools: calls };
		if (text.includes(NEEDS_DEEP))
			return { ok: false, reason: "model asked for the full loop", ms, tools: calls };
		if (result.unverified.length > 0)
			return {
				ok: false,
				// The loop's empty-reply stall is not a claim: name it for what it is.
				reason: result.unverified.every(isEmptyReplyStall)
					? `no answer after ${calls} tool calls`
					: "unverified claims",
				ms,
				tools: calls,
				// What the loop flagged (model output, not the user's prompt), for the run log.
				claims: result.unverified.slice(0, 5).map((c) => c.slice(0, 120)),
			};
		if (calls === 0) {
			// Nothing was read: that is the model's memory, not the source (8PO review, round 2).
			return { ok: false, reason: "no source read", ms, tools: calls };
		}
		return {
			ok: true,
			result: { ...result, content: `${QUICK_LABEL} ${text}` },
			answer: text,
			ms,
			tools: calls,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			// ESC aborts the lane's own signal too: name it, so the turn ends (#3416).
			reason: opts.signal?.aborted ? "aborted" : ac.signal.aborted ? `over ${budgetMs} ms` : msg,
			ms: elapsed(),
			tools: calls,
		};
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

// ── Quick then full: checking the quick answer (#3416, design R2.1, R3.1, R3.2) ──
// The full answer always runs after a shown quick answer. A deterministic fact
// comparison labels it. A false "corrected" is acceptable; a false "confirmed" is the
// failure that matters, so every rule below can only turn confirmed into corrected.

export type QuickVerdict = "confirmed" | "corrected" | "unknown" | "unchecked" | "stopped" | "none";

/** Each text is compared up to this many chars, so the scan stays bounded. */
export const COMPARE_MAX_CHARS = 20_000;
/** Facts named in a verdict line, and facts written to the run log (each FACT_LOG_CHARS at most). */
export const VERDICT_FACTS_SHOWN = 4;
export const FACTS_LOGGED = 8;
export const FACT_LOG_CHARS = 40;
export const PROVISIONAL_LOG_CHARS = 300;
/** A quick answer with more facts than this is never confirmed (bounds the comparison). */
export const COMPARE_MAX_FACTS = 32;

const CUE_WORDS = new Set([
	"not",
	"legacy",
	"old",
	"wrong",
	"was",
	"deprecated",
	"previously",
	"formerly",
	"unused",
]);
const CUE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["instead", "of"],
	["rather", "than"],
	["no", "longer"],
	["used", "to"],
];
const WINDOW_WORDS = 3;

type Tok = { text: string; start: number; end: number; word: boolean };

/**
 * Words (internal `_ ' / - .` kept, so paths and identifiers stay whole) and the
 * punctuation the rules use. Every other character is skipped. One linear pass.
 */
const TOKEN = /[A-Za-z0-9_](?:[A-Za-z0-9_'’/-]|\.(?=[A-Za-z0-9_]))*|[,;.:=!?\n]/g;

/** Index of the first token ending after `offset` (binary search). */
function tokenIndexAt(toks: Tok[], offset: number): number {
	let lo = 0;
	let hi = toks.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (toks[mid].end <= offset) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function tokenize(text: string): Tok[] {
	const out: Tok[] = [];
	for (const m of text.slice(0, COMPARE_MAX_CHARS).matchAll(TOKEN)) {
		const t = m[0];
		const start = m.index ?? 0;
		out.push({ text: t, start, end: start + t.length, word: /^[A-Za-z0-9_]/.test(t) });
	}
	return out;
}

const NUMBER_FACT = /^\d{2,}$/;
const CAPS_FACT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const PATH_LIKE = /\/|[A-Za-z0-9-]\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** A token that states a fact: a number of 2 or more digits, or an ALL_CAPS identifier of 3 or more chars. */
function factShaped(t: string): boolean {
	return NUMBER_FACT.test(t) || (t.length >= 3 && CAPS_FACT.test(t) && /[A-Z]/.test(t));
}

/** The words of an identifier: split on `_` and camelCase, lowercased (LEGACY_PORTS, oldPort). */
function subWords(t: string): string[] {
	return t
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\s]+/)
		.map((w) => w.toLowerCase())
		.filter(Boolean);
}

/** Cue spans in a window of words: [first index, last index]. "isn't" spells `not`. */
function cueSpans(words: string[]): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i].toLowerCase();
		if (/n['’]t$/.test(w) || subWords(words[i]).some((s) => CUE_WORDS.has(s))) {
			spans.push([i, i]);
			continue;
		}
		const next = words[i + 1]?.toLowerCase();
		if (next && CUE_PAIRS.some(([a, b]) => a === w && b === next)) spans.push([i, i + 1]);
	}
	return spans;
}

const SENTENCE_END = new Set([";", ".", "!", "?", "\n"]);
const isWindowStop = (t: Tok) =>
	(!t.word && SENTENCE_END.has(t.text)) || (t.word && t.text.toLowerCase() === "but");
const isClauseStop = (t: Tok) =>
	(!t.word && (t.text === "," || SENTENCE_END.has(t.text))) ||
	(t.word && /^(and|but)$/i.test(t.text));

/** Up to WINDOW_WORDS words on one side of a token range, stopping at `;` `.` `but` (never at commas). */
function windowWords(toks: Tok[], from: number, step: 1 | -1): string[] {
	const out: string[] = [];
	for (let i = from; i >= 0 && i < toks.length && out.length < WINDOW_WORDS; i += step) {
		if (isWindowStop(toks[i])) break;
		if (toks[i].word) out.push(toks[i].text);
	}
	return step === -1 ? out.reverse() : out;
}

/**
 * Clean: no contrast cue within 3 words either side. A cue after the fact belongs to a
 * later fact token in the same window ("4180 rather than 5180" refutes 5180, not 4180).
 */
function cleanAt(toks: Tok[], first: number, last: number): boolean {
	if (cueSpans(windowWords(toks, first - 1, -1)).length > 0) return false;
	const after = windowWords(toks, last + 1, 1);
	return cueSpans(after).every(([, end]) => after.slice(end + 1).some(factShaped));
}

/** Pairing clause index of every token: clauses split on `,` `;` `.` `and` `but`. */
function clauseIds(toks: Tok[]): number[] {
	let id = 0;
	return toks.map((t) => (isClauseStop(t) ? ++id : id));
}

type Fact = { value: string; label: string | null };

const LABEL_SKIP = new Set(["=", ":", "is"]);

/** The nearest content word within 2 tokens before index i (`=`, `:` and `is` skipped). */
function labelBefore(toks: Tok[], i: number): string | null {
	let seen = 0;
	for (let k = i - 1; k >= 0 && seen < 2; k--) {
		const t = toks[k].text;
		if (LABEL_SKIP.has(t.toLowerCase())) continue;
		seen++;
		const w = t.toLowerCase();
		if (toks[k].word && /^[a-z][a-z'-]*$/.test(w) && !STOPWORDS.has(w) && !factShaped(t)) return w;
	}
	return null;
}

const QUICK_LITERAL = /"([^"\n]{1,80})"|`([^`\n]{1,80})`/g;

/** Strip the provisional label and a DONE marker, if present. */
function answerText(text: string): string {
	const t = text.trimStart();
	const body = t.startsWith(QUICK_LABEL) ? t.slice(QUICK_LABEL.length) : t;
	return body.replace(/^\s*\**DONE\**\s*:\s*\**\s*/, "");
}

/** The facts a quick answer states, in order: numbers, quoted or backticked literals, ALL_CAPS. Paths and prose are not facts. */
export function quickFacts(text: string): Fact[] {
	const src = answerText(text).slice(0, COMPARE_MAX_CHARS);
	const toks = tokenize(src);
	const found: Array<Fact & { at: number }> = [];
	const seen = new Set<string>();
	const inLiteral = new Array<boolean>(toks.length).fill(false);
	for (const m of src.matchAll(QUICK_LITERAL)) {
		const value = (m[1] ?? m[2] ?? "").trim();
		const at = m.index ?? 0;
		const ti = tokenIndexAt(toks, at);
		for (let k = ti; k < toks.length && toks[k].end <= at + m[0].length; k++) inLiteral[k] = true;
		if (!value || PATH_LIKE.test(value) || seen.has(value)) continue;
		seen.add(value);
		found.push({ value, at, label: ti < toks.length ? labelBefore(toks, ti) : null });
	}
	toks.forEach((t, i) => {
		if (!t.word || inLiteral[i] || !factShaped(t.text) || seen.has(t.text)) return;
		seen.add(t.text);
		found.push({ value: t.text, at: t.start, label: labelBefore(toks, i) });
	});
	return found.sort((a, b) => a.at - b.at).map(({ value, label }) => ({ value, label }));
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/** Token ranges where `value` occurs in the deep text as a whole word or phrase. */
function occurrences(deep: string, toks: Tok[], value: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let at = deep.indexOf(value); at >= 0; at = deep.indexOf(value, at + 1)) {
		const end = at + value.length;
		if (WORD_CHAR.test(value[0]) && at > 0 && WORD_CHAR.test(deep[at - 1])) continue;
		if (WORD_CHAR.test(value[value.length - 1]) && end < deep.length && WORD_CHAR.test(deep[end]))
			continue;
		const first = tokenIndexAt(toks, at);
		let last = first;
		while (last + 1 < toks.length && toks[last + 1].start < end) last++;
		if (first < toks.length) out.push([first, last]);
	}
	return out;
}

/**
 * Pairing (R3.2, plus one rule of mine): when the fact's label is in the deep text, the
 * occurrence's clause must hold it, and the nearest quick label before the occurrence in
 * that clause (else the nearest after it) must be this one. The second rule stops
 * "unset=3000 staging=4180" on one line from pairing 3000 with staging.
 */
function pairedAt(
	toks: Tok[],
	clause: number[],
	first: number,
	label: string,
	labels: ReadonlySet<string>,
): boolean {
	const c = clause[first];
	let nearest: string | null = null;
	for (let k = first - 1; k >= 0 && clause[k] === c; k--) {
		const w = toks[k].text.toLowerCase();
		if (toks[k].word && labels.has(w)) {
			nearest = w;
			break;
		}
	}
	if (nearest === null) {
		for (let k = first + 1; k < toks.length && clause[k] === c; k++) {
			const w = toks[k].text.toLowerCase();
			if (toks[k].word && labels.has(w)) {
				nearest = w;
				break;
			}
		}
	}
	return nearest === label;
}

export type QuickComparison = {
	verdict: Exclude<QuickVerdict, "stopped" | "none">;
	/** The quick answer's facts, in order. */
	facts: string[];
};

/**
 * Compare the quick answer with the full answer. Deterministic.
 * unchecked: the full answer is not clean (gated, unverified notes or failed).
 * unknown: the quick answer stated no comparable fact.
 * confirmed: every quick fact has a clean, correctly paired occurrence, in the same order.
 * corrected: anything else.
 */
export function compareQuick(
	quickText: string,
	deepText: string,
	deepClean = true,
): QuickComparison {
	const facts = quickFacts(quickText);
	const values = facts.map((f) => f.value);
	if (!deepClean) return { verdict: "unchecked", facts: values };
	if (facts.length === 0) return { verdict: "unknown", facts: values };
	if (facts.length > COMPARE_MAX_FACTS) return { verdict: "corrected", facts: values };
	const deep = deepText.slice(0, COMPARE_MAX_CHARS);
	const toks = tokenize(deep);
	const clause = clauseIds(toks);
	const deepWords = new Set(toks.filter((t) => t.word).map((t) => t.text.toLowerCase()));
	const labels = new Set(facts.map((f) => f.label).filter((l): l is string => l !== null));
	let lastAt = -1;
	for (const fact of facts) {
		const pair = fact.label !== null && deepWords.has(fact.label);
		const hit = occurrences(deep, toks, fact.value).find(
			([first, last]) =>
				cleanAt(toks, first, last) &&
				(!pair || pairedAt(toks, clause, first, fact.label as string, labels)),
		);
		if (!hit || hit[0] <= lastAt) return { verdict: "corrected", facts: values };
		lastAt = hit[0];
	}
	return { verdict: "confirmed", facts: values };
}

function factList(facts: readonly string[]): string {
	const shown = facts.slice(0, VERDICT_FACTS_SHOWN);
	return shown.length > 0 ? ` (${shown.join(", ")})` : "";
}

/**
 * The first line of the final answer (design R2.4, R3.5). Each line stands on its own: a
 * channel that never showed the quick answer can still read it. No internal terms.
 */
export function verdictLine(
	verdict: Exclude<QuickVerdict, "none">,
	facts: readonly string[],
	opts: { failed?: boolean } = {},
): string {
	const f = factList(facts);
	switch (verdict) {
		case "confirmed":
			return `Checked: my quick answer${f} was right.`;
		case "corrected":
			return `Correction: my quick answer${f} did not match what I found when I checked. Use this instead:`;
		case "unknown":
			return "Full answer (I could not compare it with my quick answer):";
		case "unchecked":
			return `I could not check my quick answer${f}, so do not rely on it.${opts.failed ? " Try asking again, or narrow the question." : ""}`;
		case "stopped":
			return `Stopped before I could check my quick answer${f}, so do not rely on it.`;
	}
}
