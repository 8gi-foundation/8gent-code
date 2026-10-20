/**
 * The one place a client's text is read before the model sees it (#4530).
 *
 * Every channel's `prompt` frame passes gateInput (gateway.ts, in front of
 * pool.chat). Today the gate does deterministic command dispatch (the slash
 * registry); later deterministic checks hang here, not at each call site.
 * `handled: false` is the only outcome that reaches the model. The pool and gateway
 * gates run commands; a caller whose text is not a command line (goal text, a voice
 * transcript the pool will gate again) passes `classifyOnly` and nothing executes.
 */

import { type SlashContext, type SlashResult, runSlash } from "./slash";

export type GateContext = SlashContext;
export type GateResult = SlashResult;

export async function gateInput(
	text: unknown,
	ctx: GateContext,
	opts: { classifyOnly?: boolean } = {},
): Promise<GateResult> {
	if (typeof text !== "string") return { handled: false };
	return runSlash(text, ctx, opts);
}

/**
 * True when `text` is a line the gate could answer. Anything else is never handled,
 * so a caller may skip the async gate and keep its synchronous prefix (a pool turn
 * marks itself busy before its first await; the work queue and journal depend on it).
 */
export function isSlashLine(text: unknown): boolean {
	return typeof text === "string" && text.trimStart().startsWith("/");
}
