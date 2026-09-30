/**
 * Table daemon wiring (contract section 3.8, 4.3).
 *
 * - installTablePolicies(): deny-by-default policy shape for Table agents.
 * - tableSessionId(): deterministic per-(channel, agent) session id.
 * - resolveMentionedAgents(): mention router - @handle -> agent member ids.
 * - TABLE_AGENT_SCOPE / CHANNEL_POST_ACTION: shared constants.
 *
 * ── Deviation from the contract's illustrative snippet (documented) ──
 * The contract sketches two rules:
 *     { action:"*",           effect:"block", condition:{agentScope:"__table__"} }
 *     { action:"channel_post",effect:"allow", condition:{agentScope:"__table__"} }
 * The REAL policy engine (packages/permissions/policy-engine.ts) does not take
 * an `effect`/`condition:{}` object - a rule is { action, decision, condition
 * (a keyword string), agentScope } and BLOCK rules are evaluated BEFORE allow
 * rules. A literal `action:"*"` block would therefore also block `channel_post`
 * (the allow never runs). So we mirror the proven SPAWNED_AGENT_RESTRICTIONS
 * shape instead: an enumerated set of BLOCK rules scoped to `__table__`
 * covering every side-effecting action class (run_command, network_request,
 * write_file, ...), plus one explicit `channel_post` ALLOW. channel_post is not
 * blocked, so it resolves to allow (belt-and-suspenders: the explicit allow
 * documents intent and is assertable in tests). Deny-by-default for the
 * dangerous classes is preserved and test-proven. No bypassPermissions path is
 * introduced. Table agents gate under the scope id `__table__` exactly as
 * spawned agents gate under `__spawned__`; the real participant id rides in
 * `context.actorId` for the audit trail.
 */

import { addPolicy, getPolicies } from "../permissions/policy-engine.js";
import type { PolicyActionType, PolicyRule } from "../permissions/types.js";
import { OFFICERS } from "./officers.js";
import type { TableStore } from "./store.js";

/** Restricted agent scope Table agents bind under (mirrors "__spawned__"). */
export const TABLE_AGENT_SCOPE = "__table__";

/**
 * New policy action string for posting to a channel. The engine accepts
 * `PolicyActionType | string`; no enum edit is required. Documented here
 * alongside the network/command actions per contract section 4.2.
 */
export const CHANNEL_POST_ACTION = "channel_post" as PolicyActionType;

/**
 * Side-effecting action classes a Table agent must never reach. Mirrors
 * SPAWNED_AGENT_RESTRICTIONS. `channel_post` is deliberately absent.
 */
const TABLE_DENIED_ACTIONS: PolicyActionType[] = [
	"run_command",
	"network_request",
	"write_file",
	"delete_file",
	"git_push",
	"git_commit",
	"secret_write",
	"env_access",
	"agent_mail_send",
	"peers_send",
	// F3: term_* windowed-session orchestration and computer/desktop control.
	// These map to dedicated action strings in tools.ts TOOL_ACTION_MAP; blocking
	// them here (scope __table__ only) closes the two ToolG8 bypasses without
	// changing behaviour for any other scope.
	"term_orchestration" as PolicyActionType,
	"computer_use" as PolicyActionType,
	// Desktop tools are gated as desktop_use (#3213); block that name too.
	"desktop_use" as PolicyActionType,
];

/**
 * Always-true condition for a scoped rule. The engine's condition parser
 * rejects an empty value ("field contains " trims to invalid syntax), so we
 * assert on `agentId`, which the `agentScope` filter guarantees equals
 * `__table__` whenever one of these rules is even considered. The clause is
 * therefore always satisfied for exactly the scoped agent and never for
 * anyone else.
 */
const TABLE_SCOPE_CONDITION = `agentId contains ${TABLE_AGENT_SCOPE}`;

/**
 * The Table agent restriction rule set: an enumerated BLOCK per side-effecting
 * action class, scoped to `__table__`, plus one explicit `channel_post` ALLOW.
 * A Table agent has no legitimate use for the blocked actions.
 */
export const TABLE_AGENT_RESTRICTIONS: PolicyRule[] = [
	...TABLE_DENIED_ACTIONS.map(
		(action): PolicyRule => ({
			name: `table-no-${action.replace(/_/g, "-")}`,
			action,
			condition: TABLE_SCOPE_CONDITION,
			decision: "block",
			message: `Table agents (scope ${TABLE_AGENT_SCOPE}) cannot perform ${action}. They may only post to channels they belong to.`,
			agentScope: TABLE_AGENT_SCOPE,
		}),
	),
	{
		name: "table-allow-channel-post",
		action: CHANNEL_POST_ACTION,
		condition: TABLE_SCOPE_CONDITION,
		decision: "allow",
		message: "Table agents may post to channels they belong to.",
		agentScope: TABLE_AGENT_SCOPE,
	},
];

/**
 * Install the Table policy rules into the process-global policy engine.
 * Idempotent: rules already present (by name) are skipped, so calling this at
 * every daemon boot - or twice in one test - is safe. Returns the names of the
 * rules that are now installed.
 */
export function installTablePolicies(): string[] {
	const existing = new Set(getPolicies().map((r) => r.name));
	for (const rule of TABLE_AGENT_RESTRICTIONS) {
		if (!existing.has(rule.name)) {
			// Clone so the engine's internal mutation (immutable=false) can't
			// leak back into our exported template array.
			addPolicy({ ...rule });
		}
	}
	return TABLE_AGENT_RESTRICTIONS.map((r) => r.name);
}

/** Deterministic daemon session id for an (agent, channel) Table pair. */
export function tableSessionId(channelId: string, agentId: string): string {
	return `table:${channelId}:${agentId}`;
}

/**
 * Mention router: given raw @handles from scanMentions(), return the
 * participant ids of the AGENT members of `channelId` they resolve to. An
 * agent resolves when a member exists whose participantId === "agent:<handle>"
 * and whose role is "member" or "bot". Humans and non-members never resolve.
 * Order + de-dup follow the input handle order.
 */
export function resolveMentionedAgents(
	store: TableStore,
	channelId: string,
	handles: string[],
): string[] {
	const members = store.listMembers(channelId);
	const agentIndex = new Map<string, string>(); // participantId -> role
	for (const m of members) {
		if (m.participantId.startsWith("agent:") && (m.role === "member" || m.role === "bot")) {
			agentIndex.set(m.participantId, m.role);
		}
	}
	// Handle aliasing: "@8TO", "@8to", "@rishi", "@Rishi" all resolve to
	// agent:8TO. Codes and officer first names, case-insensitive - people
	// naturally type the name, not the code.
	const alias = new Map<string, string>(); // lowercase handle -> canonical code
	for (const [code, meta] of Object.entries(OFFICERS)) {
		alias.set(code.toLowerCase(), code);
		const name = (meta as { name?: string }).name ?? "";
		// Alias EVERY sensible way a human writes the name. "AI James" must match
		// "@aijames" and "@james" as well as "@8EO" - aliasing only the first token
		// left the exec officer unreachable by anything resembling his name.
		const tokens = name.split(/\s+/).filter(Boolean);
		if (name) alias.set(name.replace(/\s+/g, "").toLowerCase(), code); // "aijames"
		for (const t of tokens) {
			const k = t.toLowerCase();
			// Don't let a 1-2 char fragment ("ai") shadow a real officer name.
			if (k.length >= 3 && !alias.has(k)) alias.set(k, code);
		}
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const handle of handles) {
		const canonical = alias.get(handle.toLowerCase()) ?? handle;
		const pid = `agent:${canonical}`;
		if (agentIndex.has(pid) && !seen.has(pid)) {
			seen.add(pid);
			out.push(pid);
		}
	}
	return out;
}
