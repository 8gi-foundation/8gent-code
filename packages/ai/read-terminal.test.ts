/**
 * read_terminal returns a tab's recent output with control sequences removed,
 * labelled as untrusted. A fake session registered as tab t1 echoes what it is sent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	_registerTerminalForTest,
	_unregisterTerminalForTest,
	approveTerminalRead,
	writeToTerminal,
} from "../../apps/tui/src/hooks/useTerminal.js";
import { getPermissionManager } from "../permissions";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
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

const savedTTY = process.stdin.isTTY;
const savedHeadless = process.env.EIGHT_HEADLESS;

function attachTerminal(answer: "approve" | "deny", asked: string[]) {
	(process.stdin as { isTTY?: boolean }).isTTY = true;
	delete process.env.EIGHT_HEADLESS;
	registerTuiApprovalHandler(async (req) => {
		asked.push(req.action ?? "");
		return answer;
	});
}

beforeAll(() => {
	_registerTerminalForTest("t1", fakeSession());
	approveTerminalRead("t1");
});
afterAll(() => _unregisterTerminalForTest("t1"));
afterEach(() => {
	_resetTuiApprovalChannel();
	getPermissionManager().disableInfiniteMode();
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
});

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

describe("read_terminal approval and limits", () => {
	test("an unapproved tab prompts in Infinite mode; a decline reads nothing", async () => {
		_registerTerminalForTest("t3", fakeSession());
		try {
			getPermissionManager().enableInfiniteMode();
			const asked: string[] = [];
			attachTerminal("deny", asked);
			const out = await run("read_terminal", { tabId: "t3" });
			expect(asked).toEqual(["Read Terminal Tab"]);
			expect(out.error).toContain("[PERMISSION DENIED]");
			expect(out.output).toBeUndefined();
		} finally {
			_unregisterTerminalForTest("t3");
		}
	});

	test("a read approval does not unlock typing: the next write_terminal still asks", async () => {
		_registerTerminalForTest("t6", fakeSession());
		try {
			getPermissionManager().enableInfiniteMode();
			const asked: string[] = [];
			attachTerminal("approve", asked);
			expect((await run("read_terminal", { tabId: "t6" })).ok).toBe(true);
			expect((await run("write_terminal", { tabId: "t6", input: "echo typed" })).ok).toBe(true);
			expect(asked).toEqual(["Read Terminal Tab", "Type Into Terminal Tab"]);
			// And a declined write after a read approval sends nothing.
			_registerTerminalForTest("t7", fakeSession());
			approveTerminalRead("t7");
			attachTerminal("deny", asked);
			const out = await run("write_terminal", { tabId: "t7", input: "echo no" });
			expect(out.error).toContain("[PERMISSION DENIED]");
			expect((await run("read_terminal", { tabId: "t7" })).output).toBe("");
		} finally {
			_unregisterTerminalForTest("t6");
			_unregisterTerminalForTest("t7");
		}
	});

	test("a write approval covers reads: write_terminal then read_terminal asks once", async () => {
		_registerTerminalForTest("t4", fakeSession());
		try {
			getPermissionManager().enableInfiniteMode();
			const asked: string[] = [];
			attachTerminal("approve", asked);
			expect((await run("write_terminal", { tabId: "t4", input: "echo shared" })).ok).toBe(true);
			expect((await run("read_terminal", { tabId: "t4" })).output).toBe("echo shared");
			expect(asked).toEqual(["Type Into Terminal Tab"]);
		} finally {
			_unregisterTerminalForTest("t4");
		}
	});

	test("with no terminal to ask, an unapproved read is refused", async () => {
		_registerTerminalForTest("t5", fakeSession());
		try {
			process.env.EIGHT_HEADLESS = "1";
			expect((await run("read_terminal", { tabId: "t5" })).error).toContain("[PERMISSION DENIED]");
		} finally {
			_unregisterTerminalForTest("t5");
		}
	});

	test("the joined output is capped at the last 16 KB", async () => {
		const long = "x".repeat(2000);
		for (let i = 0; i < 30; i++) writeToTerminal("t1", `${i}:${long}`);
		const out = await run("read_terminal", { tabId: "t1", lines: 200 });
		expect(out.output.length).toBeLessThanOrEqual(16384);
		expect(out.truncated).toBe(true);
		expect(out.output.endsWith(`29:${long}`)).toBe(true);
	});

	test("C1 controls, including U+009B sequences, are removed", async () => {
		writeToTerminal("t1", "a\u009b31mb\u0085c\u009dd");
		const out = await run("read_terminal", { tabId: "t1", lines: 1 });
		expect(out.output).toBe("abcd");
		expect(/[\u0080-\u009f]/.test(out.output)).toBe(false);
	});
});
