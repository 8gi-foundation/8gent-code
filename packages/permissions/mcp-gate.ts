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
import { hasTuiApprovalHandler, requestTuiDecision } from "./tui-approval-channel";
import type { PolicyContext } from "./types";

export const MCP_POLICY_ACTION = "mcp_call" as const;

/** The approval card's title for an MCP call. */
export const MCP_APPROVAL_ACTION = "MCP tool call";

export function mcpPolicyContext(server: string, tool: string): PolicyContext {
	return { server, tool, action: `${server}/${tool}` };
}

/** Untrusted text on one line, as clean() in packages/mcp/index.ts (not imported: a cycle). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
function oneLine(value: string): string {
	return value.replace(UNSAFE, "?").replace(/[\n\t]+/g, " ");
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
	const label = `mcp_call_tool ${server}/${tool}`;
	let json: string;
	try {
		json = JSON.stringify(args ?? {}) ?? "{}";
	} catch {
		json = "[arguments that cannot be shown as JSON]";
	}
	const command = oneLine(`${label} ${json}`);
	return askPerson(
		{
			action: MCP_APPROVAL_ACTION,
			command,
			full: true,
			details: oneLine(`${reason ?? "This MCP tool call needs your approval."} ${label} ${json}`),
		},
		`[BLOCKED] ${label} needs the person's approval and there is no one to ask in this session. Nothing was sent to the MCP server. Do not retry this call.`,
		`[PERMISSION DENIED] The person declined ${label}. Nothing was sent to the MCP server. Do not retry this call.`,
		`[BLOCKED] ${label} was not shown for approval: the approval card must show the whole call and it does not fit on this screen. Nothing was sent to the MCP server. Send smaller arguments, or ask the person to make the window larger.`,
	);
}

/** The approval card's title before the lean path starts MCP servers (#3474). */
export const MCP_START_APPROVAL_ACTION = "Start MCP servers";

/** Ask once before MCP servers start, one line per server; null to start, else the refusal. */
export async function askMcpStartApproval(servers: string[]): Promise<string | null> {
	const n = `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`;
	const cwd = oneLine(process.cwd());
	return askPerson(
		{
			action: MCP_START_APPROVAL_ACTION,
			command: `start ${n} from your MCP config (working directory ${cwd}):\n${servers.map((l) => `- ${l}`).join("\n")}`,
			full: true,
			details: `Using MCP starts these servers from your MCP config, as configured, in ${cwd}:\n${servers.map((l) => `- ${l}`).join("\n")}`,
		},
		"[BLOCKED] Starting MCP servers needs the person's approval and there is no one to ask in this session. No server was started. Do not retry; restart the session with a person present to be asked again.",
		"[PERMISSION DENIED] The person declined to start the MCP servers. No server was started. Do not retry; the answer stands for this session, and the person can restart the session to be asked again.",
		"[BLOCKED] The MCP servers were not offered for approval: the approval card must show every server in full and it does not fit on this screen. No server was started. Do not retry; the person can list fewer servers in ~/.8gent/mcp.json or make the window larger, then restart the session to be asked again.",
	);
}

async function askPerson(
	request: { action: string; details: string; command?: string; full?: boolean },
	noOne: string,
	declined: string,
	doesNotFit: string,
): Promise<string | null> {
	const manager = getPermissionManager();
	if (manager.isInfiniteMode()) return null;
	let approved: boolean;
	if (hasTuiApprovalHandler()) {
		const decision = await requestTuiDecision(request);
		if (decision === "unfit") return doesNotFit;
		approved = decision === "approve";
	} else if (process.stdin.isTTY && !process.env.EIGHT_HEADLESS) {
		approved = await manager.requestPermission(request.action, request.details, undefined, {
			defaultNo: true,
		});
	} else {
		return noOne;
	}
	return approved ? null : declined;
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
