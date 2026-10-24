/**
 * Tab lamps (#4928): the ▲ lands on the tab whose call asked, never on the
 * focused tab by guess. Two tabs are running, the background one asks, and the
 * bar is driven the way app.tsx drives it: the card carries its asker's
 * permission holder, and tabOfHolder maps it back to a tab.
 */
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import {
	type PermissionModeHolder,
	createChildHolder,
	createPermissionHolder,
	runWithPermissionHolder,
} from "../../../../../packages/permissions/permission-mode.js";
import {
	_resetTuiApprovalChannel,
	requestTuiApproval,
} from "../../../../../packages/permissions/tui-approval-channel.js";
import { _resetApprovalCard, useApprovalCard } from "../../hooks/useApprovalCard.js";
import type { WorkspaceTab } from "../../hooks/useWorkspaceTabs.js";
import { approvalTab, tabOfHolder } from "../../lib/tab-lamps.js";
import { TabBar } from "../TabBar.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const tabs = ["Orchestrator", "Engineer", "QA"].map((title, i) => ({
	id: `t${i}`,
	type: "chat",
	title,
	active: i === 0,
	createdAt: "",
	lastActiveAt: "",
})) as unknown as WorkspaceTab[];

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return null;
	}
}

let unmount: (() => void) | null = null;
afterEach(() => {
	unmount?.();
	unmount = null;
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

function setup(opts: { running?: string[]; yolo?: boolean } = {}) {
	const holders = new Map<string, PermissionModeHolder>(
		tabs.map((tb) => [tb.id, createPermissionHolder("ask")]),
	);
	const running = opts.running ?? ["t0", "t1"];
	function Bar() {
		const pending = useApprovalCard(
			undefined,
			opts.yolo ? { needed: () => true, answer: () => {} } : undefined,
		);
		// Focused tab is t0, as in app.tsx's noHolderTab.
		const owner = pending === null ? null : (approvalTab(pending.holder, holders, "t0") ?? null);
		return (
			<TabBar
				tabs={tabs}
				onSwitch={() => {}}
				isTabProcessing={(id) => running.includes(id)}
				lampFor={(id) => ({ needsYou: id === owner, unread: null })}
				animate={false}
				width={80}
			/>
		);
	}
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		last: string;
		write: (s: string) => boolean;
	};
	out.columns = 80;
	out.rows = 24;
	out.isTTY = false;
	out.last = "";
	out.write = (s: string) => {
		const f = strip(s);
		if (f.trim()) out.last = f;
		return true;
	};
	const app = render(<Bar />, {
		stdout: out as unknown as NodeJS.WriteStream,
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	unmount = () => app.unmount();
	return {
		holders,
		strangerHolder: createPermissionHolder("ask"),
		row: () => out.last.split("\n")[0] ?? "",
	};
}

test("two running tabs, the background one asks: ▲ lands only on it", async () => {
	const { holders, row } = setup();
	await sleep(30);
	expect(row()).toContain("Orchestrator ◐");
	expect(row()).toContain("Engineer ◐");
	const asked = runWithPermissionHolder(holders.get("t1"), () =>
		requestTuiApproval({ action: "shell", details: "", command: "ls" }),
	);
	await sleep(60);
	expect(row()).toContain("Engineer ▲");
	expect(row()).toContain("Orchestrator ◐");
	expect(row()).not.toContain("Orchestrator ▲");
	expect(row().split("▲").length - 1).toBe(1);
	void asked;
});

test("a child run by the background tab's turn lights that tab, not the focused one", async () => {
	const { holders, row } = setup();
	await sleep(30);
	const child = createChildHolder(holders.get("t1") as PermissionModeHolder);
	runWithPermissionHolder(child, () =>
		requestTuiApproval({ action: "shell", details: "", command: "ls" }),
	);
	await sleep(60);
	expect(row()).toContain("Engineer ▲");
	expect(row()).not.toContain("Orchestrator ▲");
});

test("tabOfHolder is undefined for a call that is no tab's", () => {
	const a = createPermissionHolder("ask");
	expect(tabOfHolder(createPermissionHolder("ask"), new Map([["t0", a]]))).toBeUndefined();
	expect(tabOfHolder(undefined, new Map([["t0", a]]))).toBeUndefined();
	expect(tabOfHolder(a, new Map([["t0", a]]))).toBe("t0");
});

test("the yolo question lands on the focused tab even when another tab is running", async () => {
	const { holders, row } = setup({ running: ["t1"], yolo: true });
	await sleep(30);
	expect(row()).toContain("1] Orchestrator   2] Engineer ◐");
	runWithPermissionHolder(holders.get("t1"), () =>
		requestTuiApproval({ action: "shell", details: "", command: "ls" }),
	);
	await sleep(60);
	expect(row()).toContain("Orchestrator ▲");
	expect(row()).not.toContain("Engineer ▲");
	expect(row().split("▲").length - 1).toBe(1);
});

test("a holder that belongs to no tab lights nothing", async () => {
	const { strangerHolder, row } = setup();
	await sleep(30);
	runWithPermissionHolder(strangerHolder, () =>
		requestTuiApproval({ action: "shell", details: "", command: "ls" }),
	);
	await sleep(60);
	expect(row()).not.toContain("▲");
	expect(row()).toContain("Orchestrator ◐");
});
