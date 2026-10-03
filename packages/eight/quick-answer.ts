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

/** Deterministic classifier. Same input, same class. */
export function classifyPrompt(raw: string): PromptClass {
	const text = raw.trim().toLowerCase();
	if (!text) return "unclear";
	const asked = text.replace(NEGATED_ACTION, " ");
	if (clauses(asked).some(opensWithAction)) return "deep";
	if (DISCUSSION.test(text)) return "deep";
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
export const LEFTOVER_CALL = /\{\s*"name"\s*:\s*"\w+"\s*,\s*"arguments"|```tool_call/;

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
	| { ok: true; result: TextToolAgentResult; ms: number; tools: number }
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
		if (LEFTOVER_CALL.test(text))
			return { ok: false, reason: "tool-call markup in the answer", ms, tools: calls };
		if (NON_ANSWER.test(text))
			return { ok: false, reason: "model said it could not answer", ms, tools: calls };
		if (text.includes(NEEDS_DEEP))
			return { ok: false, reason: "model asked for the full loop", ms, tools: calls };
		if (result.unverified.length > 0)
			return {
				ok: false,
				// The loop's empty-reply stall is not a claim: name it for what it is.
				reason: result.unverified.every((u) =>
					u.startsWith("the model ended the turn without an answer"),
				)
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
		return { ok: true, result: { ...result, content: `${QUICK_LABEL} ${text}` }, ms, tools: calls };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			reason: ac.signal.aborted ? `over ${budgetMs} ms` : msg,
			ms: elapsed(),
			tools: calls,
		};
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}
