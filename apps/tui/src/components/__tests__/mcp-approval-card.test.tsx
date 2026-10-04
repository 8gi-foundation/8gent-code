/**
 * The MCP start card shows every server in full, or is never raised (#3474,
 * 8SO round 2). Before, the card rendered `start 3 MCP servers: a | b | c`
 * on one truncated row, so at 120 columns the third server (whatever it ran)
 * was past the edge when the person pressed Y.
 *
 * This drives the real path: describeServer -> askMcpStartApproval -> the
 * TUI approval channel -> useApprovalCard -> InlineApprovalPrompt, rendered
 * through Ink at 120 columns, and checks each server's whole line is on
 * screen. The gate's own fit rule is pinned in packages/permissions/mcp-gate.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import { describeServer } from "../../../../../packages/mcp/lean.js";
import {
	TUI_CARD_CHROME_COLS,
	askMcpStartApproval,
	wrappedRows,
} from "../../../../../packages/permissions/mcp-gate.js";
import { _resetTuiApprovalChannel } from "../../../../../packages/permissions/tui-approval-channel.js";
import {
	_resetApprovalCard,
	settleApprovalKey,
	useApprovalCard,
} from "../../hooks/useApprovalCard.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return null;
	}
}
type FakeStdout = Writable & { columns: number; rows: number; last: string };
function makeStdout(columns: number, rows: number): FakeStdout {
	const o = new Writable({
		write(chunk, _e, cb) {
			const s = chunk.toString();
			if (s.trim()) o.last = s;
			cb();
		},
	}) as FakeStdout;
	o.columns = columns;
	o.rows = rows;
	o.last = "";
	return o;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

function Harness() {
	const p = useApprovalCard();
	return p ? <InlineApprovalPrompt target={p.target} reason={p.reason} full={p.full} /> : null;
}

/** The card's text rows, border and padding removed, each trimmed. */
function cardRows(frame: string): string[] {
	return strip(frame)
		.split("\n")
		.filter((l) => l.includes("│"))
		.map((l) =>
			l
				.replace(/^\s*│\s?/, "")
				.replace(/\s?│\s*$/, "")
				.trimEnd(),
		);
}

test("three servers at 120 columns: every server line is on the card in full", async () => {
	const lines = [
		{
			type: "stdio" as const,
			name: "github",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
		},
		{
			type: "stdio" as const,
			name: "filesystem",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
			env: { FS_TOKEN: "value-never-on-card" },
		},
		{
			type: "stdio" as const,
			name: "notes",
			command: "/bin/sh",
			args: ["-c", "HIDDEN_THIRD_SERVER_PAYLOAD"],
		},
	].map(describeServer);
	const stdout = makeStdout(120, 30);
	const cols = process.stdout as unknown as { columns?: number; rows?: number };
	const saved = { c: cols.columns, r: cols.rows };
	Object.defineProperty(process.stdout, "columns", {
		value: 120,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true, writable: true });
	try {
		instance = render(<Harness />, {
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(120, 30) as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		});
		await tick();
		const answer = askMcpStartApproval(lines);
		await tick(100);
		const rows = cardRows(stdout.last);
		const text = rows.join("\n");
		// Each server's line is on screen whole, on its own row.
		for (const l of lines) expect(rows).toContain(`- ${l}`);
		expect(text).toContain("HIDDEN_THIRD_SERVER_PAYLOAD");
		expect(text).toContain("(env: FS_TOKEN)");
		expect(text).not.toContain("value-never-on-card");
		expect(text).toContain("[Y] approve");
		// The gate's row estimate is never below what Ink drew for the target.
		const targetRows = rows.length - 2; // ASK row and key row
		const target = `start 3 MCP servers from your MCP config (working directory ${process.cwd()}):\n${lines.map((l) => `- ${l}`).join("\n")}`;
		expect(wrappedRows(target, 120 - TUI_CARD_CHROME_COLS)).toBeGreaterThanOrEqual(targetRows);
		settleApprovalKey("n", {});
		expect(await answer).toStartWith("[PERMISSION DENIED]");
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: saved.c,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: saved.r,
			configurable: true,
			writable: true,
		});
	}
});

test("a card without `full` still renders on one truncated row (other tools unchanged)", async () => {
	const stdout = makeStdout(80, 30);
	instance = render(<InlineApprovalPrompt target={`cd /a/${"b".repeat(200)} && bun test`} />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(80, 30) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	expect(cardRows(stdout.last).length).toBe(1);
});
