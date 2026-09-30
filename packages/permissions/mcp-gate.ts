/**
 * The permission gate every MCP tool call passes before it reaches a server
 * (#3230).
 *
 * An MCP server runs whatever its author wrote: it can write files, send
 * mail, open pull requests, spend money. Before this gate, `mcp_call_tool`
 * had no policy action, so the ToolExecutor's ToolG8 check never ran, and
 * the AI SDK tool and the per-server bridged tools called the server
 * directly. Every permission mode, Ask included, let the model run any MCP
 * tool with no card.
 *
 * Now every path gates the call as the `mcp_call` action class, with the
 * server and tool as `server`, `tool` and `action` ("server/tool") so a
 * policy rule can allow a trusted tool by name. The decision:
 *
 *   block rule (Table, shadow)  -> refused, never asked
 *   allow rule                  -> runs
 *   anything else               -> the person is asked (engine default for
 *                                  mcp_call is ask, as desktop_use, #3213)
 *     Infinite                  -> runs without a card
 *     no approval card, no TTY  -> refused; nothing reaches the server
 */

import { getPermissionManager } from "./index";
import { ToolG8 } from "./toolg8";
import { hasTuiApprovalHandler, requestTuiApproval } from "./tui-approval-channel";
import type { PolicyContext } from "./types";

export const MCP_POLICY_ACTION = "mcp_call" as const;

/** The approval card's title for an MCP call. */
export const MCP_APPROVAL_ACTION = "MCP tool call";

export function mcpPolicyContext(server: string, tool: string): PolicyContext {
	return { server, tool, action: `${server}/${tool}` };
}

/**
 * Ask the person before an MCP call the policy did not allow outright.
 * Returns null when the call may run, or the refusal to hand to the model.
 * `reason` is the policy's reason, shown on the card.
 */
export async function askMcpApproval(
	server: string,
	tool: string,
	args: Record<string, unknown> | undefined,
	reason: string | undefined,
): Promise<string | null> {
	const manager = getPermissionManager();
	if (manager.isInfiniteMode()) return null;
	const label = `mcp_call_tool ${server}/${tool}`;
	const request = {
		action: MCP_APPROVAL_ACTION,
		details: `${reason ?? "This MCP tool call needs your approval."} Server: ${server}. Tool: ${tool}. Args: ${JSON.stringify(args ?? {})}`,
	};
	let approved: boolean;
	if (hasTuiApprovalHandler()) {
		approved = (await requestTuiApproval(request)) === true;
	} else if (process.stdin.isTTY && !process.env.EIGHT_HEADLESS) {
		approved = await manager.requestPermission(request.action, request.details);
	} else {
		return `[BLOCKED] ${label} needs the person's approval and there is no one to ask in this session. Nothing was sent to the MCP server. Do not retry this call.`;
	}
	if (!approved) {
		return `[PERMISSION DENIED] The person declined ${label}. Nothing was sent to the MCP server. Do not retry this call.`;
	}
	return null;
}

/**
 * Gate one MCP call end to end: policy, then the person when the policy
 * asks. For callers that are not the ToolExecutor (which runs the policy
 * half in its own ToolG8 block). Returns null when the call may run.
 */
export async function gateMcpCall(
	agentId: string,
	server: string,
	tool: string,
	args?: Record<string, unknown>,
): Promise<string | null> {
	const gate = ToolG8.instance().gate(agentId, MCP_POLICY_ACTION, mcpPolicyContext(server, tool));
	if (gate.allowed) return null;
	if (gate.requiresApproval) return askMcpApproval(server, tool, args, gate.reason);
	return `[BLOCKED] mcp_call_tool ${server}/${tool} was refused by policy: ${gate.reason ?? "no reason given"}. Nothing was sent to the MCP server. Do not retry this call.`;
}
