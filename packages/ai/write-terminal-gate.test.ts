/**
 * write_terminal goes through the same command policy as term_send, and the
 * first send to each tab asks a person, in Infinite mode too. Approval is
 * remembered per tab for the session only.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// bun's mock.module outlives this file: keep the real module and put it back afterwards.
const realUseTerminal = { ...(await import("../../apps/tui/src/hooks/useTerminal.js")) };
afterAll(() => {
	mock.module("../../apps/tui/src/hooks/useTerminal.js", () => realUseTerminal);
});

const sent: Array<[string, string]> = [];
// Open tabs and their approval, as the registry entry holds them.
const tabs = new Map<string, { label: string; approved: boolean }>();
mock.module("../../apps/tui/src/hooks/useTerminal.js", () => ({
	...realUseTerminal,
	writeToTerminal: (tabId: string, input: string) => {
		sent.push([tabId, input]);
		return `Sent to terminal tab ${tabId}`;
	},
	listTerminals: () => [...tabs.keys()],
	describeTerminal: (id: string) => tabs.get(id)?.label ?? null,
	isTerminalApproved: (id: string) => tabs.get(id)?.approved === true,
	approveTerminal: (id: string) => {
		const t = tabs.get(id);
		if (t) t.approved = true;
	},
}));

import { getPermissionManager } from "../permissions";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { agentTools } from "./tools";

// Built from parts so the line is not a literal destructive command in source.
const WIPE_ROOT = ["rm", "-rf", "/"].join(" ");

const savedTTY = process.stdin.isTTY;
const savedHeadless = process.env.EIGHT_HEADLESS;
// biome-ignore lint/suspicious/noExplicitAny: tool execute signature is loose in tests
const write = (tabId: string, input: string) =>
	(agentTools as any).write_terminal.execute({ tabId, input }, {});

function attachTerminal(answer: "approve" | "deny", asked: string[]) {
	(process.stdin as { isTTY?: boolean }).isTTY = true;
	delete process.env.EIGHT_HEADLESS;
	registerTuiApprovalHandler(async (req) => {
		asked.push(req.command ?? "");
		return answer;
	});
}

beforeEach(() => {
	sent.length = 0;
	tabs.clear();
	tabs.set("t1", { label: "pi", approved: false });
	tabs.set("t2", { label: "hermes", approved: false });
});

afterEach(() => {
	_resetTuiApprovalChannel();
	getPermissionManager().disableInfiniteMode();
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
});

describe("write_terminal gate", () => {
	test("a blocked command is refused, Infinite or not, and nobody is asked", async () => {
		const asked: string[] = [];
		attachTerminal("approve", asked);
		for (const infinite of [false, true]) {
			if (infinite) getPermissionManager().enableInfiniteMode();
			const out = await write("t1", WIPE_ROOT);
			expect(JSON.stringify(out)).toContain("[PERMISSION DENIED]");
		}
		expect(sent).toEqual([]);
		expect(asked).toEqual([]);
	});

	test("an unapproved tab in Infinite mode prompts, and a decline sends nothing", async () => {
		getPermissionManager().enableInfiniteMode();
		const asked: string[] = [];
		attachTerminal("deny", asked);
		const out = await write("t1", "echo hi");
		expect(asked).toEqual(["echo hi"]);
		expect(JSON.stringify(out)).toContain("[PERMISSION DENIED]");
		expect(sent).toEqual([]);
	});

	test("a tab that does not exist is refused before anyone is asked", async () => {
		getPermissionManager().enableInfiniteMode();
		const asked: string[] = [];
		attachTerminal("approve", asked);
		const out = await write("nope", "echo hi");
		expect(JSON.stringify(out)).toContain("No terminal open for tab nope");
		expect(asked).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("closing a tab clears its approval; a new tab with the same id asks again", async () => {
		const asked: string[] = [];
		attachTerminal("approve", asked);
		await write("t1", "echo a");
		tabs.delete("t1");
		tabs.set("t1", { label: "pi", approved: false });
		await write("t1", "echo b");
		expect(asked).toEqual(["echo a", "echo b"]);
	});

	test("with no terminal to ask, the first send is refused", async () => {
		process.env.EIGHT_HEADLESS = "1";
		getPermissionManager().enableInfiniteMode();
		const out = await write("t1", "echo hi");
		expect(JSON.stringify(out)).toContain("[PERMISSION DENIED]");
		expect(sent).toEqual([]);
	});

	test("an approved tab sends, and is not asked again; another tab still asks", async () => {
		getPermissionManager().enableInfiniteMode();
		const asked: string[] = [];
		attachTerminal("approve", asked);
		expect(await write("t1", "echo one")).toMatchObject({ ok: true, tabId: "t1" });
		expect(await write("t1", "echo two")).toMatchObject({ ok: true });
		expect(asked).toEqual(["echo one"]);
		expect(await write("t2", "echo three")).toMatchObject({ ok: true, tabId: "t2" });
		expect(asked).toEqual(["echo one", "echo three"]);
		expect(sent.map(([t, i]) => `${t}:${i}`)).toEqual([
			"t1:echo one",
			"t1:echo two",
			"t2:echo three",
		]);
	});
});
