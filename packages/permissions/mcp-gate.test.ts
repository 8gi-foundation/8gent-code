/**
 * The MCP approval cards show everything they ask about, or refuse (#3474,
 * 8SO round 2). The TUI card used to show one truncated row: a second or
 * third server, or a call's arguments, could sit past the edge while the
 * person pressed Y. Now the request carries `full` and the whole text; when
 * that text needs more rows than the terminal has, nothing is asked and
 * nothing runs. The render side is pinned in
 * apps/tui/src/components/__tests__/mcp-approval-card.test.tsx.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	TUI_CARD_RESERVED_ROWS,
	askMcpApproval,
	askMcpStartApproval,
	wrappedRows,
} from "./mcp-gate";
import {
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "./tui-approval-channel";

const out = process.stdout as unknown as { columns?: number; rows?: number };
const saved = { columns: out.columns, rows: out.rows };
function terminal(columns: number, rows: number) {
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(process.stdout, "rows", {
		value: rows,
		configurable: true,
		writable: true,
	});
}
let asked: TuiApprovalRequest[] = [];
function answer(decision: "approve" | "deny") {
	asked = [];
	registerTuiApprovalHandler(async (req) => {
		asked.push(req);
		return decision;
	});
}
afterEach(() => {
	_resetTuiApprovalChannel();
	terminal(saved.columns as number, saved.rows as number);
});

const THREE = [
	"github: npx -y @modelcontextprotocol/server-github",
	"filesystem: npx -y @modelcontextprotocol/server-filesystem /Users/me/projects",
	"notes: /bin/sh -c HIDDEN_THIRD_SERVER_PAYLOAD",
];

describe("wrappedRows", () => {
	test("counts newline rows, word wrap and hard breaks of long words", () => {
		expect(wrappedRows("abc", 10)).toBe(1);
		expect(wrappedRows("abc\ndef", 10)).toBe(2);
		expect(wrappedRows("aaaa bbbb cccc", 9)).toBe(2);
		expect(wrappedRows("x".repeat(25), 10)).toBe(3);
		expect(wrappedRows(`ab ${"x".repeat(25)}`, 10)).toBe(3); // Ink fills the row first too
	});
});

describe("start card", () => {
	test("three servers at 120x30: one request, every server line in full, flagged full", async () => {
		terminal(120, 30);
		answer("deny");
		const r = await askMcpStartApproval(THREE);
		expect(r).toStartWith("[PERMISSION DENIED]");
		expect(r).toContain("restart the session to be asked again");
		expect(asked.length).toBe(1);
		expect(asked[0].full).toBe(true);
		for (const line of THREE) expect(asked[0].command).toContain(`\n- ${line}`);
		expect(asked[0].command).toContain(`working directory ${process.cwd()}`);
	});

	test("more servers than the terminal has rows for: refused, no card", async () => {
		terminal(120, 30);
		answer("approve");
		const many = Array.from(
			{ length: 30 - TUI_CARD_RESERVED_ROWS + 1 },
			(_, i) => `s${i}: /bin/s${i}`,
		);
		const r = await askMcpStartApproval(many);
		expect(r).toStartWith("[BLOCKED] The MCP servers were not offered for approval");
		expect(r).toContain("restart the session");
		expect(asked).toEqual([]);
	});

	test("a narrow terminal that would wrap one long line past the rows: refused, no card", async () => {
		terminal(40, 20);
		answer("approve");
		const r = await askMcpStartApproval([`x: /bin/x ${"a".repeat(400)}`]);
		expect(r).toStartWith("[BLOCKED]");
		expect(asked).toEqual([]);
	});
});

describe("per-call card", () => {
	test("names the server, tool and the full arguments on one line, flagged full", async () => {
		terminal(120, 30);
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
		terminal(120, 30);
		answer("deny");
		await askMcpApproval("s", "t", { a: "x‮y" }, undefined);
		expect(asked[0].command).toBe('mcp_call_tool s/t {"a":"x?y"}');
	});

	test("arguments too long for the terminal: refused, no card, nothing sent", async () => {
		terminal(120, 30);
		answer("approve");
		const r = await askMcpApproval("s", "write", { body: "z".repeat(5000) }, undefined);
		expect(r).toStartWith("[BLOCKED] mcp_call_tool s/write was not shown for approval");
		expect(r).toContain("Nothing was sent");
		expect(asked).toEqual([]);
	});
});
