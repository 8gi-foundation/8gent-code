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
 * The TUI card (InlineApprovalPrompt with `full`) shows the command wrapped
 * across the card's width: the round border and padding take 4 columns. Lines
 * beyond what the terminal can show are never cut; the request is refused
 * instead (#3474, 8SO round 2). TUI_CARD_RESERVED_ROWS is the card's own
 * frame (border, ASK row, key row, margin) plus the input box and HUD below it.
 */
export const TUI_CARD_CHROME_COLS = 4;
export const TUI_CARD_RESERVED_ROWS = 12;

/**
 * One line of untrusted text for a card: control, zero-width and bidi
 * characters become "?", newlines and tabs a space, as clean() in
 * packages/mcp/index.ts (not imported: packages/mcp/tool-bridge.ts imports
 * this file, so importing back would make a cycle).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
function oneLine(value: string): string {
	return value.replace(UNSAFE, "?").replace(/[\n\t]+/g, " ");
}

/**
 * Rows `text` takes when wrapped greedily at `width` on spaces, words longer
 * than a row broken hard (Ink's wrap). Never fewer than Ink renders.
 */
export function wrappedRows(text: string, width: number): number {
	const w = Math.max(1, width);
	let rows = 0;
	for (const line of text.split("\n")) {
		rows++;
		let col = 0;
		for (const [i, word] of line.split(" ").entries()) {
			if (i > 0) {
				if (col + 1 > w) {
					rows++;
					col = 0;
				} else col++;
			}
			let len = word.length;
			if (col > 0 && col + len > w && len <= w) {
				rows++;
				col = 0;
			}
			while (col + len > w) {
				len -= w - col;
				rows++;
				col = 0;
			}
			col += len;
		}
	}
	return rows;
}

/** Null when the TUI card can show `text` in full in this terminal, else why not. */
export function cardFitRefusal(text: string): string | null {
	const cols = process.stdout.columns || 80;
	const room = (process.stdout.rows || 24) - TUI_CARD_RESERVED_ROWS;
	const need = wrappedRows(text, cols - TUI_CARD_CHROME_COLS);
	return need <= room
		? null
		: `it needs ${need} rows on the approval card and this terminal has room for ${Math.max(0, room)}`;
}

/**
 * Ask the person before an MCP call the policy did not allow outright.
 * Returns null when the call may run, or the refusal to hand to the model.
 * `reason` is the policy's reason, shown on the card. The TUI card shows
 * `mcp_call_tool server/tool {args}` in full, or the call is refused.
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
			details: `${reason ?? "This MCP tool call needs your approval."} Server: ${server}. Tool: ${tool}. Args: ${json}`,
		},
		`[BLOCKED] ${label} needs the person's approval and there is no one to ask in this session. Nothing was sent to the MCP server. Do not retry this call.`,
		`[PERMISSION DENIED] The person declined ${label}. Nothing was sent to the MCP server. Do not retry this call.`,
		(why) =>
			`[BLOCKED] ${label} was not shown for approval: the card must show the whole call and ${why}. Nothing was sent to the MCP server. Send smaller arguments, or ask the person to run it from a session with a larger terminal.`,
	);
}

/** The approval card's title before the lean path starts MCP servers (#3474). */
export const MCP_START_APPROVAL_ACTION = "Start MCP servers";

/**
 * Ask once before MCP servers are started: each line names one server, what
 * will run (command and args) or be contacted (URL), and the names of the env
 * variables its config sets. Never env values. The TUI card shows every line
 * in full or the start is refused. Same rules as a call: Infinite starts
 * without a card; no card, no start. A refusal stands for the session, so
 * each one says to restart the session to be asked again.
 * Returns null when the servers may start, or the refusal for the model.
 */
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
		(why) =>
			`[BLOCKED] The MCP servers were not offered for approval: the card must show every server in full and ${why}. No server was started. Do not retry; the person can list fewer servers in ~/.8gent/mcp.json or use a larger terminal, then restart the session to be asked again.`,
	);
}

async function askPerson(
	request: { action: string; details: string; command?: string; full?: boolean },
	noOne: string,
	declined: string,
	doesNotFit: (why: string) => string,
): Promise<string | null> {
	const manager = getPermissionManager();
	if (manager.isInfiniteMode()) return null;
	let approved: boolean;
	if (hasTuiApprovalHandler()) {
		const why = request.full && request.command ? cardFitRefusal(request.command) : null;
		if (why) return doesNotFit(why);
		approved = (await requestTuiApproval(request)) === true;
	} else if (process.stdin.isTTY && !process.env.EIGHT_HEADLESS) {
		approved = await manager.requestPermission(request.action, request.details);
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
