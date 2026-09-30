/**
 * Permission modes (#3170): how much an agent may do without asking, switched
 * live per tab with Shift+Tab and carried per agent, per call.
 *
 * Four modes, one strict order (least to most permissive):
 *
 *   plan < ask < guarded < infinite
 *
 *   plan      Read-only tools only. Writes, edits, shell commands that are not
 *             on System One's read-only allowlist, and spawns are refused with
 *             a reason; the agent can still propose.
 *   ask       Today's default, unchanged: shell commands the permission layer
 *             does not already allow get the approval card.
 *   guarded   Ask with System One in front of every shell command, whatever
 *             EIGHT_SYSTEM_ONE says. A System One "allow" stands in for the
 *             card only for commands the permission layer does NOT flag as
 *             dangerous; a dangerous command still gets the card (and is still
 *             denied when headless). A block is final; an escalate asks.
 *   infinite  Today's infinite mode: everything but the always-blocked list
 *             runs without a card. It expires after INFINITE_MODE_MAX_MS, as
 *             the process-wide flag does.
 *
 * The order is total, so a clamp is a minimum: a child gets min(parent,
 * requested), never more than its parent. A child holder also keeps a link to
 * its parent, so narrowing the parent later narrows every running child too.
 *
 * Binding: an agent owns a PermissionModeHolder. Each tool call runs inside
 * runWithPermissionHolder (AsyncLocalStorage, the #3139 pattern), so two tabs
 * in one process never see each other's mode. A call with no holder bound
 * (headless CLI, daemon, tests, any caller that never set a mode) behaves
 * exactly as before this module existed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type PermissionMode = "plan" | "ask" | "guarded" | "infinite";

/** Least to most permissive. Also the Shift+Tab cycle order. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "ask", "guarded", "infinite"];

/** Same limit as the process-wide infinite flag (packages/permissions/index.ts). */
export const INFINITE_MODE_MAX_MS = 30 * 60 * 1000;

const LABELS: Record<PermissionMode, string> = {
	plan: "Plan",
	ask: "Ask",
	guarded: "Guarded",
	infinite: "Infinite",
};

export function permissionModeLabel(mode: PermissionMode): string {
	return LABELS[mode];
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function permissionRank(mode: PermissionMode): number {
	return PERMISSION_MODES.indexOf(mode);
}

/** The next mode in the Shift+Tab cycle: plan -> ask -> guarded -> infinite -> plan. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
	return PERMISSION_MODES[(permissionRank(mode) + 1) % PERMISSION_MODES.length] as PermissionMode;
}

/** The stricter of two modes. */
export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
	return permissionRank(a) <= permissionRank(b) ? a : b;
}

/** A child's mode: the parent's when none is asked for, else the stricter of the two. */
export function clampChildMode(parent: PermissionMode, requested?: PermissionMode): PermissionMode {
	return requested === undefined ? parent : stricterMode(parent, requested);
}

// ── Holder: one per agent (a tab's agents share the tab's) ───────────

export interface PermissionModeHolder {
	mode: PermissionMode;
	/** When this holder entered infinite; drives the 30 minute expiry. */
	infiniteSince?: number;
	/** A child's parent: the child is never more permissive than it. */
	parent?: PermissionModeHolder;
}

export function createPermissionHolder(
	mode: PermissionMode,
	parent?: PermissionModeHolder,
	now: number = Date.now(),
): PermissionModeHolder {
	const holder: PermissionModeHolder = { mode, parent };
	if (mode === "infinite") holder.infiniteSince = now;
	return holder;
}

/** A holder for a spawned child: inherits, clamps, and stays linked to the parent. */
export function createChildHolder(
	parent: PermissionModeHolder,
	requested?: PermissionMode,
	now: number = Date.now(),
): PermissionModeHolder {
	return createPermissionHolder(
		clampChildMode(effectivePermissionMode(parent, now), requested),
		parent,
		now,
	);
}

export function setHolderMode(
	holder: PermissionModeHolder,
	mode: PermissionMode,
	now: number = Date.now(),
): void {
	if (mode === "infinite" && holder.mode !== "infinite") holder.infiniteSince = now;
	if (mode !== "infinite") holder.infiniteSince = undefined;
	holder.mode = mode;
}

/**
 * The mode this holder grants right now: its own mode (infinite drops back to
 * ask once expired), clamped by every ancestor.
 */
export function effectivePermissionMode(
	holder: PermissionModeHolder,
	now: number = Date.now(),
): PermissionMode {
	if (
		holder.mode === "infinite" &&
		holder.infiniteSince !== undefined &&
		now - holder.infiniteSince > INFINITE_MODE_MAX_MS
	) {
		setHolderMode(holder, "ask", now);
	}
	return holder.parent
		? stricterMode(holder.mode, effectivePermissionMode(holder.parent, now))
		: holder.mode;
}

// ── Per-call binding ──────────────────────────────────────────────────

const _holder = new AsyncLocalStorage<PermissionModeHolder>();

/** Run fn with this holder as the current call's permission mode. */
export function runWithPermissionHolder<T>(
	holder: PermissionModeHolder | undefined,
	fn: () => T,
): T {
	return holder ? _holder.run(holder, fn) : fn();
}

/** The holder bound to the call in flight, if any. */
export function currentPermissionHolder(): PermissionModeHolder | undefined {
	return _holder.getStore();
}

/** The mode of the call in flight; undefined means no mode was set (today's behaviour). */
export function currentPermissionMode(): PermissionMode | undefined {
	const h = _holder.getStore();
	return h ? effectivePermissionMode(h) : undefined;
}

// ── What each mode does ───────────────────────────────────────────────

/**
 * Tools Plan mode lets run: they read, search or list and change nothing.
 * Everything else is refused, so a new tool is refused until it is added here.
 */
export const PLAN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"get_outline",
	"get_symbol",
	"search_symbols",
	"locate",
	"get_project_outline",
	"update_plan",
	"read_file",
	"list_files",
	"git_status",
	"git_diff",
	"git_log",
	"git_branch",
	"gh_pr_list",
	"gh_pr_view",
	"gh_issue_list",
	"lsp_goto_definition",
	"lsp_find_references",
	"lsp_hover",
	"lsp_document_symbols",
	"lsp_diagnostics",
	"read_image",
	"describe_image",
	"read_pdf",
	"read_pdf_page",
	"search_pdf",
	"read_notebook",
	"web_search",
	"web_fetch",
	"check_agent",
	"list_agents",
	"background_status",
	"background_output",
	"query_design_system",
	"self_inspect",
	"recall",
	"mcp_list_tools",
]);

/** Shell tools whose command Plan mode lets through when it is provably read-only. */
const SHELL_TOOLS = new Set(["run_command"]);

export const PLAN_MODE_MARKER = "[PLAN MODE]";

function planRefusalMessage(toolName: string, why: string): string {
	return `${PLAN_MODE_MARKER} ${toolName} was not run: this agent is in Plan mode, which only reads (${why}). Nothing changed. Propose the change instead; the user can press Shift+Tab to leave Plan.`;
}

/**
 * Plan mode's gate. Null when the call may run, else the refusal the tool
 * returns. A shell command runs only if System One's read-only allowlist
 * passes it (git status, ls, cat, grep and friends) and it neither creates a
 * directory nor redirects into a file.
 */
export async function planModeRefusal(
	toolName: string,
	args: Record<string, unknown>,
): Promise<string | null> {
	if (PLAN_READ_ONLY_TOOLS.has(toolName)) return null;
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof args.command === "string" ? args.command : "";
		try {
			const { readOnlyAllowlist } = await import("../decide/allowlist");
			const r = readOnlyAllowlist(command);
			if (r.verdict !== "pass-without-model") {
				return planRefusalMessage(toolName, `the command is not provably read-only: ${r.reason}`);
			}
			// The allowlist is "harmless", not "changes nothing": it also passes
			// mkdir and redirects into temp files. Plan changes nothing.
			const { maskQuotes } = await import("../decide/rules");
			const masked = maskQuotes(command);
			if (/(^|[;&|(]\s*)mkdir\b/.test(masked))
				return planRefusalMessage(toolName, "mkdir creates a directory");
			for (const m of masked.matchAll(/\d?>>?\|?\s*([^\s;|&<>()]+)/g)) {
				const target = m[1] ?? "";
				if (target !== "/dev/null" && !/^&\d$/.test(target)) {
					return planRefusalMessage(toolName, `the command writes to ${target}`);
				}
			}
			return null;
		} catch {
			return planRefusalMessage(toolName, "the read-only check could not run");
		}
	}
	if (toolName === "spawn_agent")
		return planRefusalMessage(toolName, "spawning an agent is not a read");
	return planRefusalMessage(toolName, "this tool can change things");
}

/** The env System One reads for a call in this mode: guarded turns it on, the env flag stays a floor. */
export function systemOneEnvFor(
	mode: PermissionMode | undefined,
	env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	return mode === "guarded" ? { ...env, EIGHT_SYSTEM_ONE: "1" } : env;
}

/**
 * Guarded mode: does System One's allow stand in for the approval card?
 * Only in guarded, only on a real allow (not a human's escalate answer, which
 * already is the card), and only when the command is not flagged dangerous.
 */
export function guardedSkipsCard(
	mode: PermissionMode | undefined,
	systemOne: { run: boolean; guard?: { verdict: string } },
	dangerous: boolean,
): boolean {
	return mode === "guarded" && systemOne.run && systemOne.guard?.verdict === "allow" && !dangerous;
}

/**
 * spawn_agent runtime "claude" runs the Claude CLI with its permissions
 * skipped, which is infinite; no mode below infinite may start it.
 */
export function claudeRuntimeRefusal(mode: PermissionMode | undefined): string | null {
	if (mode === undefined || mode === "infinite") return null;
	return `[PERMISSION MODE] spawn_agent runtime "claude" was not run: it starts the Claude CLI with its permissions skipped, which is Infinite, and this agent is in ${permissionModeLabel(mode)} mode. A child is never more permissive than its parent. Use runtime "8gent", or the user can switch this tab to Infinite.`;
}
