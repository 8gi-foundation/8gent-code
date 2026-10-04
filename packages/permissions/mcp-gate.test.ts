/**
 * The MCP approval cards show everything they ask about, or refuse (#3474,
 * 8SO rounds 2 and 3). The request carries `full` and the whole text; the
 * TUI, which knows its real geometry, answers "unfit" when it cannot show
 * all of it, and the gate turns that into a refusal: nothing runs. The
 * render side is pinned in
 * apps/tui/src/components/__tests__/mcp-approval-card.test.tsx.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { askMcpApproval, askMcpStartApproval } from "./mcp-gate";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
	requestTuiApproval,
} from "./tui-approval-channel";

let asked: TuiApprovalRequest[] = [];
function answer(decision: TuiApprovalDecision) {
	asked = [];
	registerTuiApprovalHandler(async (req) => {
		asked.push(req);
		return decision;
	});
}
afterEach(() => _resetTuiApprovalChannel());

const THREE = [
	"github: npx -y @modelcontextprotocol/server-github",
	"filesystem: npx -y @modelcontextprotocol/server-filesystem /Users/me/projects",
	"notes: /bin/sh -c HIDDEN_THIRD_SERVER_PAYLOAD",
];

describe("start card", () => {
	test("one request, every server line in full, flagged full", async () => {
		answer("deny");
		const r = await askMcpStartApproval(THREE);
		expect(r).toStartWith("[PERMISSION DENIED]");
		expect(r).toContain("restart the session to be asked again");
		expect(asked.length).toBe(1);
		expect(asked[0].full).toBe(true);
		for (const line of THREE) expect(asked[0].command).toContain(`\n- ${line}`);
		expect(asked[0].command).toContain(`working directory ${process.cwd()}`);
	});

	test("the TUI could not show it whole: refused, nothing starts", async () => {
		answer("unfit");
		const r = await askMcpStartApproval(THREE);
		expect(r).toStartWith("[BLOCKED] The MCP servers were not offered for approval");
		expect(r).toContain("does not fit on this screen");
		expect(r).toContain("restart the session");
	});

	test("approved: null", async () => {
		answer("approve");
		expect(await askMcpStartApproval(THREE)).toBeNull();
	});
});

describe("per-call card", () => {
	test("names the server, tool and the full arguments on one line, flagged full", async () => {
		answer("deny");
		const r = await askMcpApproval(
			"github",
			"delete_repo",
			{ repo: "8gi-foundation/x" },
			undefined,
		);
		expect(r).toStartWith("[PERMISSION DENIED]");
		expect(asked[0].command).toBe('mcp_call_tool github/delete_repo {"repo":"8gi-foundation/x"}');
		expect(asked[0].full).toBe(true);
	});

	test("bidi and control characters in arguments are replaced on the card", async () => {
		answer("deny");
		await askMcpApproval("s", "t", { a: "x‮y" }, undefined);
		expect(asked[0].command).toBe('mcp_call_tool s/t {"a":"x?y"}');
	});

	test("the TUI could not show it whole: refused, nothing sent", async () => {
		answer("unfit");
		const r = await askMcpApproval("s", "write", { body: "z".repeat(5000) }, undefined);
		expect(r).toStartWith("[BLOCKED] mcp_call_tool s/write was not shown for approval");
		expect(r).toContain("Nothing was sent");
	});
});

test("any other yes/no caller reads 'unfit' as no", async () => {
	answer("unfit");
	expect(await requestTuiApproval({ action: "x", details: "y" })).toBe(false);
});
