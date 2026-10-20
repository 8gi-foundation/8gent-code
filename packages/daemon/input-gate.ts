/**
 * The one place a client's text is read before the model sees it (#4530).
 *
 * Every channel's `prompt` frame passes gateInput (gateway.ts, in front of
 * pool.chat). Today the gate does deterministic command dispatch (the slash
 * registry); later deterministic checks hang here, not at each call site.
 * `handled: false` is the only outcome that reaches the model.
 */

import { type SlashContext, type SlashResult, runSlash } from "./slash";

export type GateContext = SlashContext;
export type GateResult = SlashResult;

export async function gateInput(text: unknown, ctx: GateContext): Promise<GateResult> {
	if (typeof text !== "string") return { handled: false };
	return runSlash(text, ctx);
}
