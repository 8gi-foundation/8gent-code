/**
 * MCP tool calls go through the policy engine (#3230).
 *
 * `mcp_call_tool` had no TOOL_ACTION_MAP entry, so the ToolG8 gate never ran
 * and the call went straight to the server in Ask, Guarded and Infinite. The
 * AI SDK tool (packages/ai/tools.ts) and the per-server bridged tools
 * (packages/mcp/tool-bridge.ts) reached the server directly too. An MCP
 * server can do anything its author wrote it to do - write files, send mail,
 * spend money - so every call is now gated as `mcp_call`:
 *
 *   - no rule covers it -> ask the person (the default, as desktop_use, #3213)
 *   - Infinite          -> runs without a card
 *   - no one to ask     -> refused, nothing reaches the server
 *   - Table / shadow    -> hard-blocked
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools } from "../ai/tools";
import { getMCPClient } from "../mcp";
import { bridgeTools } from "../mcp/tool-bridge";
import { createPermissionHolder, runWithPermissionHolder } from "../permissions/permission-mode";
import { evaluatePolicy } from "../permissions/policy-engine";
import {
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { installTablePolicies } from "../table/wiring";
import { ToolExecutor } from "./tools";

const dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Record every call that would have reached an MCP server, instead of
// needing a live one. The gate runs before this, so an empty list means
// nothing left the process.
const client = getMCPClient();
const realCallTool = client.callTool.bind(client);
let reached: Array<{ server: string; tool: string }> = [];
client.callTool = (async (server: string, tool: string) => {
	reached.push({ server, tool });
	return { content: [{ type: "text", text: "server ran" }] };
}) as typeof client.callTool;
afterAll(() => {
	client.callTool = realCallTool;
});

const CALL = { server: "github", tool: "delete_repo", args: { repo: "8gi-foundation/x" } };

let asked: TuiApprovalRequest[];
const prevHeadless = process.env.EIGHT_HEADLESS;

function answer(decision: "approve" | "deny") {
	registerTuiApprovalHandler(async (req) => {
		asked.push(req);
		return decision;
	});
}

beforeEach(() => {
	asked = [];
	reached = [];
});
afterEach(() => {
	_resetTuiApprovalChannel();
	if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	else process.env.EIGHT_HEADLESS = prevHeadless;
});

describe("mcp_call policy", () => {
	test("an MCP call no rule covers asks, never allows", () => {
		const d = evaluatePolicy("mcp_call", { server: "github", tool: "delete_repo" });
		expect(d.allowed).toBe(false);
		expect(d.allowed === false && d.requiresApproval).toBe(true);
	});

	test("Table and shadow agents are hard-blocked, not asked", () => {
		installTablePolicies();
		for (const agentId of ["__table__", "__shadow__"]) {
			const d = evaluatePolicy("mcp_call", { agentId, server: "github", tool: "x" });
			expect(d.allowed).toBe(false);
			expect(d.allowed === false && d.requiresApproval).toBeFalsy();
		}
	});
});

describe("ToolExecutor mcp_call_tool", () => {
	test("Ask mode: the card appears, and a declined call never reaches the server", async () => {
		answer("deny");
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			exec.execute("mcp_call_tool", CALL),
		);
		expect(asked.length).toBe(1);
		expect(asked[0].action).toBe("MCP tool call");
		expect(asked[0].details).toContain("github");
		expect(asked[0].details).toContain("delete_repo");
		expect(out).toContain("[PERMISSION DENIED]");
		expect(out).toContain("Do not retry");
		expect(reached).toEqual([]);
	});

	test("Guarded mode asks too", async () => {
		answer("deny");
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		await runWithPermissionHolder(createPermissionHolder("guarded"), () =>
			exec.execute("mcp_call_tool", CALL),
		);
		expect(asked.length).toBe(1);
		expect(reached).toEqual([]);
	});

	test("an approved call reaches the server once", async () => {
		answer("approve");
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			exec.execute("mcp_call_tool", CALL),
		);
		expect(asked.length).toBe(1);
		expect(reached).toEqual([{ server: "github", tool: "delete_repo" }]);
		expect(out).toContain("server ran");
	});

	test("Infinite mode runs without a card", async () => {
		answer("deny");
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		await runWithPermissionHolder(createPermissionHolder("infinite"), () =>
			exec.execute("mcp_call_tool", CALL),
		);
		expect(asked.length).toBe(0);
		expect(reached.length).toBe(1);
	});

	test("with no one to ask, the call is refused and nothing reaches the server", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			exec.execute("mcp_call_tool", CALL),
		);
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain("Do not retry");
		expect(reached).toEqual([]);
	});

	test("mcp_list_tools stays ungated: listing contacts no server", async () => {
		const exec = new ToolExecutor(dir, "mcp-gate-test");
		await exec.execute("mcp_list_tools", {});
		expect(asked.length).toBe(0);
	});
});

describe("AI SDK mcp_call_tool", () => {
	const run = (input: typeof CALL) =>
		(agentTools.mcp_call_tool.execute as (i: unknown, o: unknown) => Promise<string>)(input, {
			experimental_context: {
				workingDirectory: dir,
				permission: createPermissionHolder("ask"),
			},
		});

	test("a declined call never reaches the server", async () => {
		answer("deny");
		const out = await run(CALL);
		expect(asked.length).toBe(1);
		expect(out).toContain("[PERMISSION DENIED]");
		expect(reached).toEqual([]);
	});

	test("headless: refused, nothing reaches the server", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const out = await run(CALL);
		expect(out).toStartWith("[BLOCKED]");
		expect(reached).toEqual([]);
	});
});

describe("bridged per-server MCP tools", () => {
	test("headless: refused, nothing reaches the server", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const tools = bridgeTools(
			"github",
			[{ name: "delete_repo", inputSchema: { type: "object" } }],
			client,
		);
		const t = Object.values(tools)[0] as {
			execute: (i: unknown, o: unknown) => Promise<string>;
		};
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			t.execute({}, {}),
		);
		expect(out).toStartWith("[BLOCKED]");
		expect(reached).toEqual([]);
	});

	test("a declined call never reaches the server", async () => {
		answer("deny");
		const tools = bridgeTools(
			"github",
			[{ name: "delete_repo", inputSchema: { type: "object" } }],
			client,
		);
		const t = Object.values(tools)[0] as {
			execute: (i: unknown, o: unknown) => Promise<string>;
		};
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			t.execute({}, {}),
		);
		expect(asked.length).toBe(1);
		expect(out).toContain("[PERMISSION DENIED]");
		expect(reached).toEqual([]);
	});
});
