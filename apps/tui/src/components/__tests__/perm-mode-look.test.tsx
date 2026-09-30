/**
 * Permission modes, the rest of the look (#3174): the footer toast, tab tags,
 * the INFINITE header chip, the approval card reason and "held by parent".
 *
 * Every frame here is a REAL Ink render into an in-memory TTY of a fixed
 * width, read back as the text a person would see (ANSI stripped), so each
 * assertion holds under NO_COLOR too: the mode is always carried by words
 * or a letter, never by colour alone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, render } from "ink";
import type React from "react";
import { useEffect } from "react";
import {
	createChildHolder,
	createPermissionHolder,
	runWithPermissionHolder,
	setHolderMode,
} from "../../../../../packages/permissions/permission-mode.js";
import {
	_resetTuiApprovalChannel,
	requestTuiApproval,
} from "../../../../../packages/permissions/tui-approval-channel.js";
import { _resetApprovalCard, useApprovalCard } from "../../hooks/useApprovalCard.js";
import { usePermToast } from "../../hooks/usePermToast.js";
import type { WorkspaceTab } from "../../hooks/useWorkspaceTabs.js";
import {
	PERM_KEY,
	PERM_TOAST_INFINITE_MS,
	PERM_TOAST_MS,
	type PermView,
	permSwitchLine,
	permTabTag,
	permToastMs,
	permView,
} from "../../lib/perm-modes-design.js";
import { HeaderBar } from "../HeaderBar.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";
import {
	type FooterData,
	type FooterToast,
	StatusSegments,
	fmSegmentWidth,
} from "../StatusFooter.js";
import { TabBar, layoutTabs } from "../TabBar.js";

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

type FakeStdout = Writable & { columns: number; rows: number; chunks: string[] };
function makeStdout(columns: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.chunks.push(chunk.toString());
			cb();
		},
	}) as FakeStdout;
	out.chunks = [];
	out.columns = columns;
	out.rows = 30;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(10);
	}
}

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

/** Mount in debug mode (each render writes the whole frame) and read the latest frame. */
function mount(node: React.ReactElement, columns: number) {
	const stdout = makeStdout(columns);
	instance = render(node, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		debug: true,
		patchConsole: false,
	});
	return {
		frame: () => stripAnsi(stdout.chunks[stdout.chunks.length - 1] ?? ""),
		all: () => stripAnsi(stdout.chunks.join("")),
	};
}

/** The footer's status area at a terminal width, as BottomBar sizes it. */
function footerWidth(columns: number): number {
	return columns - fmSegmentWidth(columns) - 1;
}

const FOOTER: FooterData = {
	mode: "Implementing",
	sessionTime: "00:14:02",
};

function Footer({
	columns,
	data,
	toast,
}: { columns: number; data: FooterData; toast?: FooterToast | null }) {
	const width = footerWidth(columns);
	return (
		<Box width={width}>
			<StatusSegments width={width} data={{ ...data, columns }} toast={toast} />
		</Box>
	);
}

describe("footer toast (#3174)", () => {
	test("160 columns: the full line, beside mode, perm and session, in place of the hints", async () => {
		const { frame } = mount(
			<Footer
				columns={160}
				data={{ ...FOOTER, permissions: "guarded" }}
				toast={{ mode: "guarded", held: false }}
			/>,
			160,
		);
		await tick();
		const f = frame();
		expect(f).toContain("Guarded: safe steps run, risky ones still ask");
		expect(f).toContain("mode Implementing [^Y]");
		expect(f).toContain(`perm Guarded [${PERM_KEY}]`);
		expect(f).toContain("session 00:14:02");
		// The toast takes the hints slot: no second row, no hints beside it.
		expect(f).not.toContain("[^X] plan");
		expect(f.trim().split("\n")).toHaveLength(1);
	});

	test("80 columns: Infinite still gets its tiny form beside mode and perm", async () => {
		const { frame } = mount(
			<Footer
				columns={80}
				data={{ ...FOOTER, permissions: "infinite" }}
				toast={{ mode: "infinite", held: false }}
			/>,
			80,
		);
		await tick();
		const f = frame();
		expect(f).toContain("never asks");
		expect(f).toContain("mode Implementing [^Y]");
		expect(f).toContain(`perm Infinite [${PERM_KEY}]`);
	});

	test("the toast clears itself, and the hints come back", async () => {
		const shown: string[] = [];
		function Probe() {
			const [toast, show] = usePermToast("t1", () => 60);
			useEffect(() => {
				show({ tabId: "t1", mode: "plan", held: false });
			}, [show]);
			shown.push(toast ? toast.mode : "none");
			return (
				<Footer
					columns={160}
					data={{ ...FOOTER, permissions: "plan" }}
					toast={toast ? { mode: toast.mode, held: toast.held } : null}
				/>
			);
		}
		const { frame } = mount(<Probe />, 160);
		await waitFor(() => frame().includes("Plan: reads and plans, changes nothing"), "toast up");
		await waitFor(() => frame().includes("[^X] plan"), "hints back", 2000);
		expect(frame()).not.toContain("changes nothing");
		expect(shown.at(-1)).toBe("none");
	});

	test("a toast raised on another tab does not show on this one", async () => {
		function Probe() {
			const [toast, show] = usePermToast("t2", () => 5000);
			useEffect(() => {
				show({ tabId: "t1", mode: "guarded", held: false });
			}, [show]);
			return (
				<Footer
					columns={160}
					data={{ ...FOOTER, permissions: "ask" }}
					toast={toast ? { mode: toast.mode, held: toast.held } : null}
				/>
			);
		}
		const { all } = mount(<Probe />, 160);
		await tick(60);
		expect(all()).not.toContain("risky ones still ask");
	});

	test("3 s for a switch, 5 s for Infinite", () => {
		expect(PERM_TOAST_MS).toBe(3000);
		expect(PERM_TOAST_INFINITE_MS).toBe(5000);
		expect(permToastMs("plan")).toBe(3000);
		expect(permToastMs("guarded")).toBe(3000);
		expect(permToastMs("infinite")).toBe(5000);
	});
});

function tab(id: string, title: string, active: boolean): WorkspaceTab {
	const now = new Date(0).toISOString();
	return {
		id,
		type: "chat",
		title,
		active,
		createdAt: now,
		lastAccessedAt: now,
		pinned: false,
		data: {},
	};
}
const TABS = [
	tab("a", "Orchestrator", true),
	tab("b", "Engineer", false),
	tab("c", "QA", false),
	tab("d", "Research", false),
];
const MODES: Record<string, PermView> = {
	a: { mode: "guarded", held: false },
	b: { mode: "ask", held: false },
	c: { mode: "plan", held: false },
	d: { mode: "infinite", held: false },
};

describe("tab tags (#3174)", () => {
	test("120+ columns: the word after the title; Ask tabs carry none", async () => {
		const { frame } = mount(
			<TabBar tabs={TABS} onSwitch={() => {}} animate={false} permFor={(id) => MODES[id]} />,
			160,
		);
		await tick();
		const row = frame().split("\n")[0] ?? "";
		expect(row).toContain("1] Orchestrator · Guarded   2] Engineer   3] QA · Plan");
		expect(row).toContain("4] Research · Infinite");
		expect(row).not.toContain("Engineer ·");
	});

	test("below 120 columns: one glyph (P, G, ∞)", async () => {
		const { frame } = mount(
			<TabBar tabs={TABS} onSwitch={() => {}} animate={false} permFor={(id) => MODES[id]} />,
			80,
		);
		await tick();
		const row = frame().split("\n")[0] ?? "";
		expect(row).toContain("1] Orchestrator G   2] Engineer   3] QA P   4] Research ∞");
	});

	test("the underline covers the title only, never the tag", () => {
		const line = layoutTabs([
			{ num: "1] ", title: "Orchestrator", active: true, tag: " · Guarded" },
			{ num: "2] ", title: "Engineer", active: false },
		]);
		expect(line.text).toBe("1] Orchestrator · Guarded   2] Engineer");
		expect(line.spans[0]).toEqual({ x: 3, width: "Orchestrator".length });
		expect(line.spans[1]?.x).toBe(line.text.indexOf("Engineer"));
	});

	test("ASCII terminals: I for Infinite and a hyphen for the dot", () => {
		expect(permTabTag({ mode: "infinite", held: false }, false, false)).toBe(" I");
		expect(permTabTag({ mode: "guarded", held: false }, true, false)).toBe(" - Guarded");
		expect(permTabTag({ mode: "ask", held: false }, true, false)).toBe("");
	});
});

describe("header chip (#3174)", () => {
	const header = (permMode: string | undefined, width: number) => (
		<HeaderBar
			workspacePath="/Users/me/code/app"
			branch="main"
			syncStatus="in sync"
			micOn={false}
			approvalPending={false}
			width={width}
			mark={false}
			permMode={permMode}
		/>
	);

	test("Infinite, and only Infinite, puts INFINITE in the header", async () => {
		for (const [mode, shows] of [
			["infinite", true],
			["guarded", false],
			["plan", false],
			["ask", false],
		] as const) {
			const { frame } = mount(header(mode, 160), 160);
			await tick();
			expect(frame().includes("INFINITE")).toBe(shows);
			instance?.unmount();
			instance = null;
		}
	});

	test("80 columns: the chip fits beside the branch, on the text row (#3238)", async () => {
		const { frame } = mount(header("infinite", 80), 80);
		await tick();
		const lines = frame().split("\n");
		expect(lines[1]).toContain("INFINITE");
		expect(lines[1]).toContain("main");
	});
});

describe("approval card reason (#3174)", () => {
	function Card() {
		const pending = useApprovalCard();
		return pending ? (
			<InlineApprovalPrompt target={pending.target} reason={pending.reason} />
		) : null;
	}

	test("Guarded: the card says a risky step is why it asked", async () => {
		const { frame } = mount(<Card />, 120);
		await tick();
		const holder = createPermissionHolder("guarded");
		void runWithPermissionHolder(holder, () =>
			requestTuiApproval({ action: "Run", details: "", command: "rm -rf build/ dist/" }),
		);
		await waitFor(() => frame().includes("rm -rf build/ dist/"), "card");
		expect(frame()).toContain("ASK risky step rm -rf build/ dist/");
	});

	test("Ask: the card is unchanged, no reason", async () => {
		const { frame } = mount(<Card />, 120);
		await tick();
		const holder = createPermissionHolder("ask");
		void runWithPermissionHolder(holder, () =>
			requestTuiApproval({ action: "Run", details: "", command: "npm publish" }),
		);
		await waitFor(() => frame().includes("npm publish"), "card");
		expect(frame()).toContain("ASK npm publish");
		expect(frame()).not.toContain("risky step");
	});
});

describe("held by parent (#3174)", () => {
	// A child set to Guarded under a Plan parent is held at Plan.
	const parent = createPermissionHolder("plan");
	const child = createChildHolder(parent);
	setHolderMode(child, "guarded");
	const view = permView(child);

	test("the view is the effective mode, marked held", () => {
		expect(view).toEqual({ mode: "plan", held: true });
		expect(permView(parent)).toEqual({ mode: "plan", held: false });
	});

	test("footer: (held by parent) at 120+ columns, (held) below", async () => {
		const wide = mount(
			<Footer columns={160} data={{ ...FOOTER, permissions: "plan", permHeld: true }} />,
			160,
		);
		await tick();
		expect(wide.frame()).toContain(`perm Plan (held by parent) [${PERM_KEY}]`);
		instance?.unmount();
		const narrow = mount(
			<Footer columns={80} data={{ ...FOOTER, permissions: "plan", permHeld: true }} />,
			80,
		);
		await tick();
		expect(narrow.frame()).toContain(`perm Plan (held) [${PERM_KEY}]`);
	});

	test("tab: '· Plan, held' when wide, the glyph when narrow", async () => {
		const tabs = TABS.slice(0, 2);
		const permFor = (id: string) => (id === "b" ? view : undefined);
		const wide = mount(
			<TabBar tabs={tabs} onSwitch={() => {}} animate={false} permFor={permFor} />,
			160,
		);
		await tick();
		expect(wide.frame()).toContain("2] Engineer · Plan, held");
		instance?.unmount();
		const narrow = mount(
			<TabBar tabs={tabs} onSwitch={() => {}} animate={false} permFor={permFor} />,
			80,
		);
		await tick();
		expect(narrow.frame()).toContain("2] Engineer P");
	});

	test("toast and chat line say the parent held it", async () => {
		const { frame } = mount(
			<Footer
				columns={160}
				data={{ ...FOOTER, permissions: "plan", permHeld: true }}
				toast={{ mode: "plan", held: true }}
			/>,
			160,
		);
		await tick();
		expect(frame()).toContain("Held at Plan: the parent agent allows no more");
		expect(permSwitchLine("plan", true)).toBe(
			"Permissions: Held at Plan: the parent agent allows no more",
		);
	});
});
