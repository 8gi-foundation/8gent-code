/**
 * Tool trail: the pure half. What one tool call looks like as a line in chat,
 * how a turn's calls collapse, and how chat messages group into turns.
 *
 * Every string here is a real result shape from packages/eight/tools.ts or
 * the policy engine, not an invented one.
 */

import { describe, expect, test } from "bun:test";
import {
	type ToolTrailEntry,
	buildChatItems,
	classifyToolResult,
	collapseTrail,
	formatTrailRow,
	summarizeToolArgs,
	toTrailEntry,
} from "./tool-trail";

const ok = (tool: string, summary: string): ToolTrailEntry => ({ tool, summary, status: "ok" });

describe("summarizeToolArgs", () => {
	test("file tools show the path", () => {
		expect(summarizeToolArgs("write_file", { path: "deck/outline.md", content: "x" })).toBe(
			"deck/outline.md",
		);
		expect(summarizeToolArgs("read_file", { file_path: "packages/decide/README.md" })).toBe(
			"packages/decide/README.md",
		);
	});

	test("run_command shows the command on one line", () => {
		expect(summarizeToolArgs("run_command", { command: "ls deck &&\n  wc -l deck/deck.md" })).toBe(
			"ls deck && wc -l deck/deck.md",
		);
	});

	test("search tools show the query or pattern", () => {
		expect(summarizeToolArgs("web_search", { query: "ink v6 flexbox" })).toBe("ink v6 flexbox");
		expect(summarizeToolArgs("grep", { pattern: "TOOLG8", path: "packages" })).toBe("TOOLG8");
	});

	test("unknown tools fall back to the first string argument, or nothing", () => {
		expect(summarizeToolArgs("git_commit", { message: "fix: thing" })).toBe("fix: thing");
		expect(summarizeToolArgs("git_status", {})).toBe("");
		expect(summarizeToolArgs("noop", undefined)).toBe("");
	});
});

describe("classifyToolResult", () => {
	test("a plain result is success", () => {
		expect(classifyToolResult(true, "File written: deck/outline.md")).toEqual({ status: "ok" });
	});

	test("ToolG8 policy block names the rule", () => {
		const preview =
			"[TOOLG8 BLOCKED] write_file did NOT run. The file deck/outline.md was NOT written. Reason: [no-secrets-in-files] Content looks like a credential";
		expect(classifyToolResult(false, preview)).toEqual({
			status: "blocked",
			reason: "blocked: [no-secrets-in-files]",
		});
	});

	test("shell sanitizer block is a bare 'blocked'", () => {
		const preview =
			"[BLOCKED] Command chaining with && is not allowed. Command: ls deck && wc -l deck/deck.md";
		expect(classifyToolResult(false, preview)).toEqual({ status: "blocked", reason: "blocked" });
	});

	test("a blocked result counts as blocked even when the event said success", () => {
		expect(classifyToolResult(true, "[BLOCKED] no. Command: x").status).toBe("blocked");
	});

	test("permission denial is 'denied'", () => {
		expect(
			classifyToolResult(false, "[PERMISSION DENIED] User declined to execute: rm -rf x"),
		).toEqual({
			status: "blocked",
			reason: "denied",
		});
	});

	test("a hook block thrown as an error is blocked", () => {
		expect(classifyToolResult(false, 'Hook blocked tool "write_file": protected path').status).toBe(
			"blocked",
		);
	});

	test("non-zero exit is a failure with the exit code", () => {
		expect(classifyToolResult(true, "Exit code 1:\n\nls: deck: No such file")).toEqual({
			status: "fail",
			reason: "exit 1",
		});
	});

	test("an error string is a failure with a short reason", () => {
		const r = classifyToolResult(false, "Error: ENOENT: no such file or directory, open 'nope.md'");
		expect(r.status).toBe("fail");
		expect(r.reason?.startsWith("ENOENT")).toBe(true);
		expect((r.reason ?? "").length).toBeLessThanOrEqual(40);
	});

	test("a failure with no preview still says it failed", () => {
		expect(classifyToolResult(false, undefined)).toEqual({ status: "fail", reason: "error" });
	});
});

describe("toTrailEntry", () => {
	test("builds an entry from a tool end event", () => {
		expect(
			toTrailEntry({
				toolName: "run_command",
				args: { command: "ls deck" },
				success: true,
				resultPreview: "deck.md\noutline.md",
			}),
		).toEqual({ tool: "run_command", summary: "ls deck", status: "ok" });
	});
});

describe("collapseTrail", () => {
	test("8 or fewer calls are shown one per line", () => {
		const entries = Array.from({ length: 8 }, (_, i) => ok("read_file", `a/${i}.ts`));
		expect(collapseTrail(entries)).toHaveLength(8);
	});

	test("above 8 calls, consecutive successful reads of one tool collapse", () => {
		const entries = [
			ok("list_files", "packages"),
			...Array.from({ length: 5 }, (_, i) => ok("read_file", `packages/decide/f${i}.ts`)),
			ok("write_file", "deck/outline.md"),
			ok("read_file", "deck/outline.md"),
			ok("run_command", "wc -l deck/outline.md"),
		];
		const rows = collapseTrail(entries);
		expect(rows).toHaveLength(5);
		expect(rows[1]).toMatchObject({ tool: "read_file", count: 5, summary: "packages/decide/" });
		expect(formatTrailRow(rows[1], 80)).toEqual({
			icon: "✓",
			text: "read_file ×5 (packages/decide/…)",
		});
	});

	test("writes, commands and failures never collapse", () => {
		const entries: ToolTrailEntry[] = [
			...Array.from({ length: 4 }, (_, i) => ok("write_file", `w${i}.md`)),
			...Array.from({ length: 3 }, () => ({
				tool: "read_file",
				summary: "missing.md",
				status: "fail" as const,
				reason: "ENOENT",
			})),
			...Array.from({ length: 3 }, (_, i) => ok("run_command", `echo ${i}`)),
		];
		expect(collapseTrail(entries)).toHaveLength(10);
	});

	test("reads with no shared directory collapse without a prefix", () => {
		const entries = [...Array.from({ length: 9 }, (_, i) => ok("read_file", `f${i}.ts`))];
		const rows = collapseTrail(entries);
		expect(rows).toHaveLength(1);
		expect(formatTrailRow(rows[0], 80).text).toBe("read_file ×9");
	});

	test("a very long turn folds its oldest successes but keeps every failure", () => {
		const entries: ToolTrailEntry[] = [];
		for (let i = 0; i < 20; i++) entries.push(ok("run_command", `step ${i}`));
		entries.splice(3, 0, {
			tool: "write_file",
			summary: "x.md",
			status: "blocked",
			reason: "blocked",
		});
		const rows = collapseTrail(entries);
		expect(rows.length).toBeLessThanOrEqual(12);
		expect(rows.some((r) => r.status === "blocked")).toBe(true);
		expect(rows[0]).toMatchObject({ folded: true });
		expect(formatTrailRow(rows[0], 80).text).toMatch(/^\d+ earlier calls$/);
		// Everything is accounted for: folded count + visible calls = total.
		const total = rows.reduce((n, r) => n + r.count, 0);
		expect(total).toBe(21);
	});
});

describe("collapseTrail with a row cap", () => {
	const mixed = (): ToolTrailEntry[] => [
		ok("write_file", "a.md"),
		{ tool: "run_command", summary: "ls a", status: "blocked", reason: "blocked" },
		ok("read_file", "a.md"),
		ok("run_command", "wc -l a.md"),
		{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" },
		ok("read_file", "b.md"),
	];

	test("never returns more rows than the cap", () => {
		for (const cap of [1, 2, 3, 4, 5]) {
			expect(collapseTrail(mixed(), cap).length).toBeLessThanOrEqual(cap);
		}
	});

	test("folds successes first so failures stay visible", () => {
		const rows = collapseTrail(mixed(), 3);
		expect(rows[0]).toMatchObject({ folded: true, count: 4 });
		expect(rows.slice(1).map((r) => r.status)).toEqual(["blocked", "fail"]);
		expect(formatTrailRow(rows[0], 80).text).toBe("4 earlier calls");
	});

	test("a cap of one summarises the whole turn and says what went wrong", () => {
		const rows = collapseTrail(mixed(), 1);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("fail");
		expect(formatTrailRow(rows[0], 80)).toEqual({
			icon: "✗",
			text: "6 calls, 1 failed, 1 blocked",
		});
	});

	test("a cap of one on an all-success turn", () => {
		const rows = collapseTrail([ok("write_file", "a"), ok("read_file", "a")], 1);
		expect(formatTrailRow(rows[0], 80)).toEqual({ icon: "✓", text: "2 calls" });
	});
});

describe("formatTrailRow", () => {
	test("success, failure and block lines", () => {
		expect(formatTrailRow({ ...ok("write_file", "deck/outline.md"), count: 1 }, 80)).toEqual({
			icon: "✓",
			text: "write_file deck/outline.md",
		});
		expect(
			formatTrailRow(
				{
					tool: "run_command",
					summary: "ls deck && wc -l deck/deck.md",
					status: "blocked",
					reason: "blocked",
					count: 1,
				},
				80,
			),
		).toEqual({ icon: "⊘", text: "run_command ls deck && wc -l deck/deck.md (blocked)" });
		expect(
			formatTrailRow(
				{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1", count: 1 },
				80,
			),
		).toEqual({ icon: "✗", text: "run_command bun test (exit 1)" });
	});

	test("a long summary is truncated so the reason survives inside the width", () => {
		const row = {
			tool: "write_file",
			summary: "a/very/long/path/that/goes/on/and/on/and/on/forever/and/ever/file.md",
			status: "blocked" as const,
			reason: "blocked: [no-secrets-in-files]",
			count: 1,
		};
		const { icon, text } = formatTrailRow(row, 60);
		expect(icon.length + 1 + text.length).toBeLessThanOrEqual(60);
		expect(text.endsWith("(blocked: [no-secrets-in-files])")).toBe(true);
		expect(text).toContain("…");
	});

	test("never exceeds a tiny width", () => {
		const row = {
			tool: "run_command",
			summary: "x".repeat(50),
			status: "fail" as const,
			reason: "exit 127",
			count: 1,
		};
		const { icon, text } = formatTrailRow(row, 16);
		expect(icon.length + 1 + text.length).toBeLessThanOrEqual(16);
	});
});

describe("buildChatItems", () => {
	type M = {
		id: string;
		role: "user" | "assistant" | "system" | "tool";
		content: string;
		timestamp: Date;
		toolTrail?: ToolTrailEntry;
	};
	const at = new Date(0);
	const msg = (id: string, role: M["role"], extra: Partial<M> = {}): M => ({
		id,
		role,
		content: id,
		timestamp: at,
		...extra,
	});

	test("tool calls attach to the assistant reply of their turn", () => {
		const items = buildChatItems<M>([
			msg("u1", "user"),
			msg("tool-start-1", "tool"),
			msg("tool-end-1", "tool", { toolTrail: ok("write_file", "a.md") }),
			msg("evidence-1", "tool"),
			msg("tool-end-2", "tool", { toolTrail: ok("read_file", "a.md") }),
			msg("a1", "assistant"),
			msg("u2", "user"),
			msg("a2", "assistant"),
		]);
		expect(items.map((i) => i.message.id)).toEqual(["u1", "a1", "u2", "a2"]);
		expect(items[1].trail.map((e) => e.tool)).toEqual(["write_file", "read_file"]);
		expect(items[3].trail).toEqual([]);
	});

	test("calls with no reply yet render as a live trail at the end", () => {
		const items = buildChatItems<M>([
			msg("u1", "user"),
			msg("tool-end-1", "tool", { toolTrail: ok("write_file", "a.md") }),
		]);
		expect(items).toHaveLength(2);
		expect(items[1].message.role).toBe("tool");
		expect(items[1].message.id).toBe("trail-tool-end-1");
		expect(items[1].trail).toHaveLength(1);
	});

	test("a turn that ended without a reply keeps its trail before the next user message", () => {
		const items = buildChatItems<M>([
			msg("u1", "user"),
			msg("tool-end-1", "tool", { toolTrail: ok("write_file", "a.md") }),
			msg("u2", "user"),
		]);
		expect(items.map((i) => i.message.id)).toEqual(["u1", "trail-tool-end-1", "u2"]);
	});

	test("system messages pass through in place", () => {
		const items = buildChatItems<M>([msg("s1", "system"), msg("u1", "user")]);
		expect(items.map((i) => i.message.id)).toEqual(["s1", "u1"]);
	});
});
