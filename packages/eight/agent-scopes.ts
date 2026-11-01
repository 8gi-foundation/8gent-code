/**
 * Agent scopes that run on a SUPPLIED system prompt and never on the coding
 * agent's own persona (see Agent: prompt assembly, planning gate, flavoring).
 *
 * - `__table__`: a chat-channel colleague. Read-only allowlist, posts through
 *   the gateway's gated write path.
 * - `__classroom__`: 8gent Browser lesson text from the open web (#3939). The
 *   input is untrusted data, so the session gets NO tools at all: no file,
 *   shell, network or browser tools, no delegation, no memory writes.
 */

export const TABLE_AGENT_SCOPE_ID = "__table__";
export const CLASSROOM_AGENT_SCOPE = "__classroom__";

/** Scopes whose supplied system prompt is used verbatim (no persona, no plan gate, no flavor). */
export function isVerbatimScope(scope: string | undefined): boolean {
	return scope === TABLE_AGENT_SCOPE_ID || scope === CLASSROOM_AGENT_SCOPE;
}

/** Scopes that are offered zero tools on every path (native and text-tool). */
export function isNoToolScope(scope: string | undefined): boolean {
	return scope === CLASSROOM_AGENT_SCOPE;
}
