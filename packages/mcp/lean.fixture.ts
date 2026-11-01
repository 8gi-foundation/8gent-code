/**
 * Test fixture for lean MCP access (#3474): a 40-tool catalogue and one
 * ~60 KB JSON answer, shaped like a real server's. Used by lean.test.ts and
 * by the fake stdio server the ToolExecutor end-to-end test spawns.
 */

import type { MCPToolSchema } from "./tool-bridge";

const AREAS = ["calendar", "crm", "billing", "docs", "issues", "files", "mail", "chat"];
const VERBS = ["list", "get", "create", "update", "search"];

export const FAKE_TOOLS: MCPToolSchema[] = AREAS.flatMap((area) =>
	VERBS.map((verb) => ({
		name: `${area}_${verb}`,
		description: `${verb[0].toUpperCase()}${verb.slice(1)} ${area} records for the workspace. Supports paging with cursor and limit, filtering by owner, status and date range, and returns the full record including audit history, custom fields and linked objects. Requires the ${area}:${verb === "list" || verb === "get" || verb === "search" ? "read" : "write"} scope.`,
		inputSchema: {
			type: "object",
			properties: {
				workspace: { type: "string", description: "Workspace id" },
				cursor: { type: "string", description: "Paging cursor from a previous call" },
				limit: { type: "number", description: "Maximum records to return (1-500)" },
				owner: { type: "string", description: "Filter by owner id" },
				status: { type: "string", description: "Filter by status" },
			},
			required: ["workspace"],
		},
	})),
);

/** The one tool a task needs; its answer is large. */
export const REPORT_TOOL: MCPToolSchema = {
	name: "ledger_quarter_report",
	description:
		"Quarterly ledger report: totals, per-account rows and the audit trail for one quarter.",
	inputSchema: {
		type: "object",
		properties: { quarter: { type: "string", description: "Quarter, e.g. 2026-Q3" } },
		required: ["quarter"],
	},
};

export const SENTINEL = "AUDIT-TRAIL-SENTINEL-7f3a";

/** A JSON answer whose useful part is tiny (totals.net): ~50 KB at 400 rows, ~20 KB at 150. */
export function bigReport(quarter: string, count = 400): string {
	const rows = Array.from({ length: count }, (_, i) => ({
		account: `ACC-${String(i).padStart(4, "0")}`,
		debit: (i * 37) % 1000,
		credit: (i * 53) % 1000,
		memo: `Routine posting ${i} for ${quarter}, reconciled against the bank feed`,
	}));
	return JSON.stringify({
		quarter,
		totals: { revenue: 1284500, costs: 903200, net: 381300, currency: "EUR" },
		rows,
		audit: `${SENTINEL} ${"checked ".repeat(200)}`,
	});
}
