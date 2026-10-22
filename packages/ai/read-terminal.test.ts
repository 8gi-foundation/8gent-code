/**
 * read_terminal returns a tab's recent output with control sequences removed,
 * labelled as untrusted. A fake session registered as tab t1 echoes what it is sent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	_registerTerminalForTest,
	_unregisterTerminalForTest,
	writeToTerminal,
} from "../../apps/tui/src/hooks/useTerminal.js";
import type { PtySession } from "../terminal-tab/index.js";
import { agentTools } from "./tools";

const ESC = String.fromCharCode(27);

function fakeSession(): PtySession {
	let handler: ((d: string) => void) | null = null;
	return {
		onData: (h: (d: string) => void) => {
			handler = h;
		},
		onExit: () => {},
		kill: () => {},
		// Echo with colour, a cursor move and a title sequence, as a real program would.
		write: (s: string) =>
			handler?.(`${ESC}]0;title\x07${ESC}[31m${s.replace("\n", "")}${ESC}[0m${ESC}[2K\r\n`),
	} as unknown as PtySession;
}

// biome-ignore lint/suspicious/noExplicitAny: tool execute signature is loose in tests
const run = (name: string, args: unknown) => (agentTools as any)[name].execute(args, {});

beforeAll(() => _registerTerminalForTest("t1", fakeSession()));
afterAll(() => _unregisterTerminalForTest("t1"));

describe("read_terminal", () => {
	test("write then read returns the echo without control sequences", async () => {
		writeToTerminal("t1", "echo hello");
		const out = await run("read_terminal", { tabId: "t1" });
		expect(out.ok).toBe(true);
		expect(out.output).toBe("echo hello");
		expect(out.output).not.toContain(ESC);
	});

	test("output is labelled untrusted", async () => {
		const out = await run("read_terminal", { tabId: "t1" });
		expect(out.untrusted).toBe(true);
		expect(out.notice).toContain("UNTRUSTED OUTPUT from terminal tab t1");
	});

	test("lines defaults to 40 and is capped at 200", async () => {
		for (let i = 0; i < 250; i++) writeToTerminal("t1", `line ${i}`);
		expect((await run("read_terminal", { tabId: "t1" })).output.split("\n")).toHaveLength(40);
		const big = await run("read_terminal", { tabId: "t1", lines: 9999 });
		expect(big.output.split("\n")).toHaveLength(200);
		expect(big.output.split("\n").at(-1)).toBe("line 249");
		expect((await run("read_terminal", { tabId: "t1", lines: 2 })).output).toBe(
			"line 248\nline 249",
		);
	});

	test("an unknown tab is an error; list_terminals shows t1", async () => {
		expect((await run("read_terminal", { tabId: "nope" })).error).toContain("No terminal open");
		expect((await run("list_terminals", {})).tabs).toContain("t1");
	});
});
