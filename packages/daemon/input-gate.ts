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

/**
 * What this daemon advertises on `session:created`, `session:resumed` and `/health`.
 * Lives beside gateInput so "input-gate" is only claimed where the gate is defined; clients
 * (the 8gent Browser) send slash lines only when it is present.
 */
export const DAEMON_CAPABILITIES: readonly string[] = Object.freeze(
	[typeof gateInput === "function" ? "input-gate" : ""].filter(Boolean),
);

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

export interface ClassifyContext {
	sessionId: string;
	channel: string;
}

export type InputKind = { kind: "pass" } | { kind: "slash" };

type Observer = (text: unknown, ctx: ClassifyContext, result: InputKind) => void;
let observer: Observer | undefined;

/** Tests watch every classification; call with nothing to stop. */
export function setClassifyObserver(fn?: Observer): void {
	observer = fn;
}

/**
 * The synchronous step EVERY line passes, at every call site, unconditionally
 * (gateway.ts in front of pool.chat, AgentPool.chat in front of the session's
 * model call). It never awaits, so a caller's synchronous prefix (the pool marks
 * a turn busy and journals it before its first await) stays intact. Any future
 * synchronous deterministic check hangs here; only `kind: "slash"` takes the
 * async handler (gateInput).
 */
export function classifyInput(text: unknown, ctx: ClassifyContext): InputKind {
	const result: InputKind =
		typeof text === "string" && text.trimStart().startsWith("/")
			? { kind: "slash" }
			: { kind: "pass" };
	observer?.(text, ctx, result);
	return result;
}
