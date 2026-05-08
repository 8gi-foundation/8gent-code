/**
 * Hands tool registration shim for the computer channel.
 *
 * The agent already has `desktop_*` tools wired into packages/computer (used by
 * apps/lil-eight). This module is the daemon-side surface that mounts the same
 * tool family for the new computer channel: it exposes the standard tool-call
 * definitions, an executor, and a NemoClaw policy gate so every call goes
 * through default-policies.yaml (`desktop_use` rules).
 *
 * `packages/hands` (the planned trycua/cua fork) is a placeholder today; once
 * driver code lands, swap the imports below from `../../computer` to `../../hands`.
 * The agent-facing surface stays identical.
 */

import {
	addToSafeList as desktopAddToSafeList,
	click as desktopClick,
	clipboardGet as desktopClipboardGet,
	clipboardSet as desktopClipboardSet,
	drag as desktopDrag,
	hover as desktopHover,
	listProcesses as desktopListProcesses,
	loadSafeList as desktopLoadSafeList,
	press as desktopPress,
	quitByName as desktopQuitByName,
	quitProcess as desktopQuitProcess,
	removeFromSafeList as desktopRemoveFromSafeList,
	screenshot as desktopScreenshot,
	scroll as desktopScroll,
	suggestQuittable as desktopSuggestQuittable,
	typeText as desktopType,
	windowList as desktopWindowList,
	getToolDefinitions as getDesktopToolDefs,
} from "../../computer";
import {
	AgentPolicyEngine,
	isEnforcing as agentPolicyEnforcing,
	logViolation,
} from "../../permissions/agent-policy";
import { evaluatePolicy } from "../../permissions/policy-engine";
import { dispatchAccessibilityTree } from "./accessibility-tree";

export interface HandsToolCtx {
	sessionId: string;
	/**
	 * Asks the user (via the daemon's approval queue) whether to allow a
	 * NemoClaw require_approval action. Default: deny.
	 */
	approve?: (req: {
		tool: string;
		input: unknown;
		reason: string;
	}) => Promise<boolean>;
	/**
	 * Resolved agent profile (issue #2423). When set, tool calls are
	 * additionally gated by the per-agent YAML policy. When unset, only
	 * the legacy NemoClaw rules apply. Lazy-loaded by the caller; the
	 * dispatcher does not parse YAML on every call.
	 */
	agentPolicy?: AgentPolicyEngine;
}

/**
 * Lazy resolved agent-policy engines, keyed by agent name. The daemon
 * loads each profile on first use and reuses the engine for subsequent
 * calls so YAML is parsed once. Exposed for callers that already have
 * an agent name but not an engine instance.
 */
const agentPolicyCache = new Map<string, AgentPolicyEngine>();

export function getAgentPolicyEngine(agentName: string): AgentPolicyEngine | undefined {
	if (!agentName) return undefined;
	const cached = agentPolicyCache.get(agentName);
	if (cached) return cached;
	try {
		const engine = AgentPolicyEngine.load(agentName);
		agentPolicyCache.set(agentName, engine);
		return engine;
	} catch (err) {
		console.warn(`[agent-policy] failed to load policy for "${agentName}": ${err}`);
		return undefined;
	}
}

/**
 * Tool definitions for the agent loop. Reuses the `desktop_*` set already
 * defined in packages/computer to avoid drift; the names also match the
 * existing case branches in packages/eight/tools.ts.
 */
export function getHandsToolDefinitions(): object[] {
	return getDesktopToolDefs();
}

/**
 * Names list for downstream logging / system-prompt generation.
 */
export const HANDS_TOOL_NAMES = [
	"desktop_screenshot",
	"desktop_click",
	"desktop_type",
	"desktop_press",
	"desktop_scroll",
	"desktop_drag",
	"desktop_hover",
	"desktop_windows",
	"desktop_clipboard",
	"desktop_processes",
	"desktop_quit_app",
	"desktop_suggest_quit",
	"desktop_safe_list",
	"desktop_accessibility_tree",
	"desktop_list_apps",
] as const;

/** Map a tool name to the NemoClaw `desktop_use` action descriptor. */
function policyActionFor(tool: string, input: Record<string, unknown>): Record<string, unknown> {
	switch (tool) {
		case "desktop_screenshot":
			return { action: "screenshot" };
		case "desktop_click":
			return { action: "click" };
		case "desktop_type":
			return { action: "type" };
		case "desktop_press":
			return { action: "press", keys: input.keys };
		case "desktop_scroll":
			return { action: "scroll" };
		case "desktop_drag":
			return { action: "drag" };
		case "desktop_hover":
			return { action: "hover" };
		case "desktop_windows":
		case "desktop_list_apps":
			return { action: "window_list" };
		case "desktop_clipboard":
			return {
				action: input.action === "set" ? "clipboard_set" : "clipboard_get",
			};
		case "desktop_processes":
			return { action: "list_processes" };
		case "desktop_quit_app":
			return { action: "quit_app" };
		case "desktop_suggest_quit":
			return { action: "suggest_quit" };
		case "desktop_safe_list":
			return { action: "safe_list" };
		case "desktop_accessibility_tree":
			return { action: "screenshot" }; // read-only equivalent under default policy
		default:
			return { action: tool };
	}
}

/**
 * Run a hands tool call through the policy engine and dispatch to the driver.
 * Returns `{ ok: true, result }` or `{ ok: false, reason }`.
 *
 * The first call to a `require_approval` tool produces a one-time prompt via
 * `ctx.approve`. If the approver is missing, the call is denied.
 */
export async function executeHandsTool(
	tool: string,
	input: Record<string, unknown>,
	ctx: HandsToolCtx,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
	// Agent-policy gate (issue #2423). Runs BEFORE NemoClaw rules so a
	// per-agent profile can deny tools that the global rule-set allows.
	// Defaults to warn-only: violations are logged but not enforced
	// unless EIGHT_AGENT_POLICY_ENFORCE=1 is set.
	if (ctx.agentPolicy) {
		const decision = ctx.agentPolicy.checkAction({
			tool,
			path: typeof input.path === "string" ? input.path : undefined,
			mode: tool.includes("write") || tool === "desktop_type" ? "write" : "read",
			rawInput: typeof input.text === "string" ? input.text : undefined,
		});
		if (!decision.allowed) {
			logViolation({
				timestamp: Date.now(),
				agent: ctx.agentPolicy.policy.agent,
				tool,
				path: typeof input.path === "string" ? input.path : undefined,
				reason: decision.reason,
				category: decision.category,
				enforced: agentPolicyEnforcing(),
			});
			if (agentPolicyEnforcing()) {
				return { ok: false, reason: `[agent-policy] ${decision.reason}` };
			}
			console.warn(`[agent-policy:warn] ${decision.reason}`);
		}
		const rate = ctx.agentPolicy.checkRateLimit("tool_call");
		if (!rate.allowed) {
			logViolation({
				timestamp: Date.now(),
				agent: ctx.agentPolicy.policy.agent,
				tool,
				reason: rate.reason,
				category: rate.category,
				enforced: agentPolicyEnforcing(),
			});
			if (agentPolicyEnforcing()) {
				return { ok: false, reason: `[agent-policy] ${rate.reason}` };
			}
			console.warn(`[agent-policy:warn] ${rate.reason}`);
		}
	}

	const policyCtx = policyActionFor(tool, input);
	const decision = evaluatePolicy("desktop_use", policyCtx);

	if (!decision.allowed && decision.requiresApproval) {
		if (!ctx.approve) {
			return {
				ok: false,
				reason: `[policy] ${decision.reason} (no approver wired)`,
			};
		}
		const approved = await ctx.approve({
			tool,
			input,
			reason: decision.reason ?? "approval required",
		});
		if (!approved) return { ok: false, reason: `[policy] user denied: ${decision.reason}` };
	} else if (!decision.allowed) {
		return { ok: false, reason: `[policy] ${decision.reason}` };
	}

	try {
		const result = await dispatch(tool, input);
		return { ok: true, result };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

async function dispatch(tool: string, input: Record<string, unknown>): Promise<unknown> {
	switch (tool) {
		case "desktop_screenshot":
			return desktopScreenshot({
				path: input.path as string | undefined,
				displayId: input.displayId as number | undefined,
			});
		case "desktop_click":
			return desktopClick({
				point: { x: Number(input.x), y: Number(input.y) },
				button: input.button as "left" | "right" | "middle" | undefined,
				count: input.count as number | undefined,
			});
		case "desktop_type":
			return desktopType({
				text: String(input.text ?? ""),
				delay: input.delay as number | undefined,
			});
		case "desktop_press":
			return desktopPress({
				keys: String(input.keys ?? ""),
				count: input.count as number | undefined,
				delay: input.delay as number | undefined,
			});
		case "desktop_scroll":
			return desktopScroll({
				direction: input.direction as "up" | "down" | "left" | "right",
				amount: input.amount as number | undefined,
				point:
					input.x !== undefined && input.y !== undefined
						? { x: Number(input.x), y: Number(input.y) }
						: undefined,
			});
		case "desktop_drag":
			return desktopDrag({
				from: { x: Number(input.fromX), y: Number(input.fromY) },
				to: { x: Number(input.toX), y: Number(input.toY) },
				button: input.button as "left" | "right" | "middle" | undefined,
				duration: input.duration as number | undefined,
			});
		case "desktop_hover":
			return desktopHover({ x: Number(input.x), y: Number(input.y) });
		case "desktop_windows":
		case "desktop_list_apps":
			return desktopWindowList();
		case "desktop_clipboard":
			return input.action === "set"
				? desktopClipboardSet(String(input.text ?? ""))
				: desktopClipboardGet();
		case "desktop_processes":
			return desktopListProcesses(
				(input.sort as "memory" | "cpu" | "name" | undefined) ?? "memory",
			);
		case "desktop_quit_app":
			if (input.pid !== undefined) {
				return desktopQuitProcess(
					Number(input.pid),
					(input.strategy as "graceful" | "force" | undefined) ?? "graceful",
				);
			}
			return desktopQuitByName(
				String(input.name ?? ""),
				(input.strategy as "graceful" | "force" | undefined) ?? "graceful",
			);
		case "desktop_suggest_quit":
			return desktopSuggestQuittable();
		case "desktop_safe_list":
			if (input.action === "add") return desktopAddToSafeList(String(input.app ?? ""));
			if (input.action === "remove") return desktopRemoveFromSafeList(String(input.app ?? ""));
			return desktopLoadSafeList();
		case "desktop_accessibility_tree":
			return dispatchAccessibilityTree(input);
		default:
			throw new Error(`hands tool not implemented: ${tool}`);
	}
}
