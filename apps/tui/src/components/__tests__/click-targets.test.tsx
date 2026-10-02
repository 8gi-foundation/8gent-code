/**
 * A click does exactly what the key does (#3239). The real components run
 * in Ink on a fake TTY with the mouse layer installed on its stdin; a
 * terminal-shaped SGR click lands on the rectangle the component registered
 * from Ink's layout, and the key's bytes reach the same useInput a key press
 * would.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, Text, render, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import {
	clearTargets,
	currentPressed,
	handleMouse,
	hitTest,
	onCopied,
	selectText,
	setSelectionIO,
	setTarget,
} from "../../lib/click-targets.js";
import { keyBytes } from "../../lib/key-bytes.js";
import { _disposeMouse, installMouse, onMouse } from "../../lib/mouse-input.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";
import { DJ_HINT, FOOTER_HINTS, StatusSegments, fitFooterHints } from "../StatusFooter.js";
import { TabBar } from "../TabBar.js";

class FakeStdin extends EventEmitter {
	isTTY = true;
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}

/** Called with each chunk Ink writes, as it writes it. */
let onWrite: ((chunk: string) => void) | null = null;

function makeStdout(columns: number) {
	const out = new Writable({
		write(chunk, _enc, cb) {
			(out as unknown as { written: string }).written += chunk.toString();
			onWrite?.(chunk.toString());
			cb();
		},
	}) as Writable & { columns: number; rows: number; written: string };
	out.written = "";
	out.columns = columns;
	out.rows = 20;
	return out;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let instance: Instance | null = null;

afterEach(() => {
	onWrite = null;
	instance?.unmount();
	instance = null;
	_disposeMouse();
	clearTargets();
});

/** Mount with the mouse layer on the same stdin Ink reads, wired like startMouse. */
async function mount(node: React.ReactElement, columns = 120, exitOnCtrlC = false) {
	const stdin = new FakeStdin();
	const stdout = makeStdout(columns);
	installMouse(
		stdin as unknown as NodeJS.ReadStream,
		{ write: () => true },
		{ enabled: true, processHooks: false },
	);
	onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
	});
	instance = render(node, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC,
		patchConsole: false,
	});
	await tick(80);
	return { stdin, stdout };
}

/** A human-style click: press and release at a target's first cell, 1-based as the terminal sends it. */
function clickAt(stdin: FakeStdin, x: number, y: number) {
	stdin.feed(`\x1b[<0;${x + 1};${y + 1}M`);
	stdin.feed(`\x1b[<0;${x + 1};${y + 1}m`);
}

function Keys({ log, children }: { log: string[]; children: React.ReactNode }) {
	useInput((input, key) => {
		if (key.ctrl) log.push(`^${input.toUpperCase()}`);
		else if (key.tab && key.shift) log.push("⇧Tab");
		else log.push(input);
	});
	return <Box flexDirection="column">{children}</Box>;
}

function targetAt(id: string): { x: number; y: number } {
	for (let y = 0; y < 30; y++)
		for (let x = 0; x < 200; x++) {
			const t = hitTest(x, y);
			if (t?.id === id) return { x, y };
		}
	throw new Error(`no target ${id}`);
}

describe("footer clicks", () => {
	test("[^P] palette sends Ctrl+P, the perm segment sends Shift+Tab, mode sends Ctrl+Y", async () => {
		const log: string[] = [];
		const { stdin, stdout } = await mount(
			<Keys log={log}>
				<Text>chat</Text>
				<StatusSegments
					width={119}
					data={{ mode: "Planning", permissions: "guarded", sessionTime: "9s" }}
				/>
			</Keys>,
		);
		for (const id of ["footer:hint:^P palette", "footer:seg:perm", "footer:seg:mode"]) {
			const { x, y } = targetAt(id);
			clickAt(stdin, x, y);
			await tick();
		}
		expect(log).toEqual(["^P", "⇧Tab", "^Y"]);
		// Nothing of the mouse bytes reached the screen or the input.
		expect(stdout.written).not.toContain("[<0;");
		expect(log.join("")).not.toContain("[<");
	});

	test("typing still types, and a release off the pressed cap cancels it", async () => {
		const log: string[] = [];
		const { stdin } = await mount(
			<Keys log={log}>
				<StatusSegments width={119} data={{ mode: "Planning", sessionTime: "9s" }} />
			</Keys>,
		);
		stdin.feed("hi");
		await tick();
		const { x, y } = targetAt("footer:hint:^P palette");
		stdin.feed(`\x1b[<0;${x + 1};${y + 1}M`);
		await tick();
		expect(currentPressed()).toBe("footer:hint:^P palette");
		stdin.feed(`\x1b[<32;${x + 40};${y + 1}M`);
		stdin.feed(`\x1b[<0;${x + 40};${y + 1}m`);
		await tick();
		expect(currentPressed()).toBeNull();
		expect(log).toEqual(["hi"]);
	});
});

/** The last frame Ink drew, ANSI stripped, as rows. */
function lastRows(stdout: { written: string }): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
	const plain = stdout.written.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	const frames = plain.split("\n").filter((l) => l.includes("mode "));
	return frames.slice(-1);
}

/** The key a footer item sends, as the Keys probe logs it. */
function loggedKey(cap: string): string {
	return cap === "⇧Tab" ? "⇧Tab" : cap;
}

describe("every footer item does what its key does (James, 2026-10-02: only plan worked)", () => {
	test("every item, on every cell it draws, sends its own key and nothing else", async () => {
		const log: string[] = [];
		const { stdin, stdout } = await mount(
			<Keys log={log}>
				<StatusSegments width={179} dj data={{ mode: "Planning", sessionTime: "3m" }} />
			</Keys>,
			180,
		);
		const row = lastRows(stdout)[0] ?? "";
		// The items James sees: the mode segment, then every key cap.
		const items: Array<{ text: string; key: string }> = [
			{ text: "mode Planning [^Y]", key: "^Y" },
			...fitFooterHints(999, false, true).map((h) => {
				const [cap = "", ...verb] = h.split(" ");
				return { text: `[${cap}] ${verb.join(" ")}`, key: loggedKey(cap) };
			}),
		];
		expect(items.map((i) => i.key)).toEqual(["^Y", "^P", "^X", "⇧Tab", "^D", "^A", "^S", "^C"]);
		for (const item of items) {
			const at = row.indexOf(item.text);
			expect({ item: item.text, drawn: at >= 0 }).toEqual({ item: item.text, drawn: true });
			for (let x = at; x < at + item.text.length; x++) {
				log.length = 0;
				clickAt(stdin, x, 0);
				await tick(15);
				expect({ item: item.text, x, keys: log }).toEqual({ item: item.text, x, keys: [item.key] });
			}
		}
	});

	test("the footer only teaches keys that do something", () => {
		const verbs = [...FOOTER_HINTS, DJ_HINT].map((h) => h.split(" ").slice(1).join(" "));
		// ^O, ^K and ^B change state nothing draws (their views have not
		// rendered since #2350), so a click on them looked dead.
		for (const dead of ["expand", "kanban", "processes"]) expect(verbs).not.toContain(dead);
		// ^D only hands the deck the keyboard while a track is loaded.
		expect(fitFooterHints(999)).not.toContain(DJ_HINT);
		expect(fitFooterHints(999, false, true)).toContain(DJ_HINT);
	});
});

describe("a key cap is clickable the moment it is drawn", () => {
	test("hints coming back after a notice are targets in the frame that draws them", async () => {
		// The App harness caught this: a click right after the hints came back
		// hit nothing, because the spans were registered in a passive effect
		// that ran after Ink had already painted the frame.
		// As the app does it: a notice that a timer clears (a default-priority
		// update, whose passive effects React runs in a later task).
		function Footer() {
			const [notice, setNotice] = useState<string | null>("sound on");
			useEffect(() => {
				const t = setTimeout(() => setNotice(null), 60);
				return () => clearTimeout(t);
			}, []);
			return (
				<Keys log={[]}>
					<StatusSegments
						width={119}
						notice={notice}
						data={{ mode: "Planning", sessionTime: "3m" }}
					/>
				</Keys>
			);
		}
		const atPaint: Array<string | null> = [];
		onWrite = (chunk) => {
			if (!chunk.includes("^S")) return;
			// The earliest a click could arrive: once this commit's synchronous
			// work is done, before any input event is handled.
			queueMicrotask(() => {
				let id: string | null = null;
				for (let x = 0; x < 120 && !id; x++) {
					const t = hitTest(x, 0);
					if (t?.id === "footer:hint:^S sound") id = t.id;
				}
				atPaint.push(id);
			});
		};
		await mount(<Footer />);
		await tick(150);
		expect(atPaint.length).toBeGreaterThan(0);
		expect(atPaint).toEqual(atPaint.map(() => "footer:hint:^S sound"));
	});
});

describe("quit by click is exactly quit by key", () => {
	async function exited(app: Instance | null, ms = 120): Promise<boolean> {
		if (!app) return false;
		return Promise.race([
			app.waitUntilExit().then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
		]);
	}

	test("typed ^C and a full click on [^C] quit both exit; a press dragged off it does not", async () => {
		// Ink reads stdin only while something listens, as the app's useInput does.
		const footer = (
			<Keys log={[]}>
				<StatusSegments width={179} data={{ mode: "Planning", sessionTime: "3m" }} />
			</Keys>
		);

		let { stdin } = await mount(footer, 180, true);
		stdin.feed("\x03");
		expect(await exited(instance)).toBe(true);
		instance = null;
		_disposeMouse();
		clearTargets();

		({ stdin } = await mount(footer, 180, true));
		let { x, y } = targetAt("footer:hint:^C quit");
		stdin.feed(`\x1b[<0;${x + 2};${y + 1}M`);
		stdin.feed(`\x1b[<32;${x - 20};${y + 1}M`);
		stdin.feed(`\x1b[<0;${x - 20};${y + 1}m`);
		expect(await exited(instance)).toBe(false);
		({ x, y } = targetAt("footer:hint:^C quit"));
		clickAt(stdin, x + 2, y);
		expect(await exited(instance)).toBe(true);
		instance = null;
	});
});

describe("tab and card clicks", () => {
	test("a click on a tab switches to it", async () => {
		const switched: string[] = [];
		const tabs = [
			{ id: "a", title: "Orchestrator", active: true, type: "chat" },
			{ id: "b", title: "Engineer", active: false, type: "chat" },
			{ id: "c", title: "QA", active: false, type: "chat" },
		] as unknown as Parameters<typeof TabBar>[0]["tabs"];
		// Keys puts Ink in raw mode, so it reads stdin as the app does.
		const { stdin } = await mount(
			<Keys log={[]}>
				<TabBar tabs={tabs} onSwitch={(id) => switched.push(id)} animate={false} width={120} />
			</Keys>,
		);
		for (const id of ["c", "b"]) {
			const { x, y } = targetAt(`tab:${id}`);
			clickAt(stdin, x + 2, y);
			await tick();
		}
		expect(switched).toEqual(["c", "b"]);
	});

	test("the approval card's [N] deny sends n", async () => {
		const log: string[] = [];
		const { stdin } = await mount(
			<Keys log={log}>
				<InlineApprovalPrompt target="rm -rf build/" />
			</Keys>,
		);
		const { x, y } = targetAt("card:N");
		clickAt(stdin, x, y);
		await tick();
		expect(log).toEqual(["n"]);
	});

	// 8SO T4 review: approve is the one decision that runs a command, so on
	// this row a miss must do nothing. The gaps between caps stay dead.
	test("every gap cell on the approval card hits no target", async () => {
		await mount(
			<Keys log={[]}>
				<InlineApprovalPrompt target="rm -rf build/" />
			</Keys>,
		);
		const y = targetAt("card:Y").y;
		const owners: (string | null)[] = [];
		for (let x = 0; x < 120; x++) owners.push(hitTest(x, y)?.id ?? null);
		// Cells left of [Y] and right of [S] belong to nobody either.
		const first = owners.indexOf("card:Y");
		const last = owners.lastIndexOf("card:S");
		const runs: string[] = [];
		for (let x = first; x <= last; x++) {
			const id = owners[x] ?? "gap";
			if (runs[runs.length - 1]?.split("x")[0] !== id) runs.push(`${id}x1`);
			else {
				const [, n] = (runs.pop() as string).split("x");
				runs.push(`${id}x${Number(n) + 1}`);
			}
		}
		// "[Y] approve  [N] deny  [E] edit  [S] skip": each two-cell gap is dead.
		expect(runs).toEqual([
			"card:Yx11",
			"gapx2",
			"card:Nx8",
			"gapx2",
			"card:Ex8",
			"gapx2",
			"card:Sx8",
		]);
		expect(owners[first - 1]).toBeNull();
		expect(owners[last + 1]).toBeNull();
	});

	test("press on [Y], release in the gap: cancelled, nothing approved", async () => {
		const log: string[] = [];
		const { stdin } = await mount(
			<Keys log={log}>
				<InlineApprovalPrompt target="rm -rf build/" />
			</Keys>,
		);
		const { x: yStart, y: row } = targetAt("card:Y");
		let lastY = yStart;
		while (hitTest(lastY + 1, row)?.id === "card:Y") lastY++;
		const gapX = lastY + 1;
		expect(hitTest(gapX, row)).toBeUndefined();
		const ev = (kind: "press" | "release", x: number) => ({
			kind,
			button: 0,
			x,
			y: row,
			shift: false,
			alt: false,
			ctrl: false,
		});
		// Straight through the click layer: the release reports a cancel.
		expect(handleMouse(ev("press", lastY))).toBe("press");
		expect(currentPressed()).toBe("card:Y");
		expect(handleMouse(ev("release", gapX))).toBe("cancel");
		expect(currentPressed()).toBeNull();
		// And the way a terminal sends it: press on Y, release one cell past it.
		stdin.feed(`\x1b[<0;${lastY + 1};${row + 1}M`);
		stdin.feed(`\x1b[<0;${gapX + 1};${row + 1}m`);
		await tick();
		expect(currentPressed()).toBeNull();
		expect(log).toEqual([]);
	});
});

describe("click-target rules", () => {
	test("the topmost target wins where two overlap (a surface over the HUD)", () => {
		setTarget({ id: "hud", x: 0, y: 0, w: 10, h: 1, z: 0, action: () => {} });
		setTarget({ id: "palette", x: 5, y: 0, w: 10, h: 1, z: 20, action: () => {} });
		expect(hitTest(2, 0)?.id).toBe("hud");
		expect(hitTest(6, 0)?.id).toBe("palette");
		expect(hitTest(30, 0)).toBeUndefined();
	});

	test("a drag off every target copies the text under it and reports the length", () => {
		const copied: string[] = [];
		const heard: number[] = [];
		setSelectionIO(
			() => "hello world\nsecond line",
			(t) => copied.push(t),
		);
		const off = onCopied((n) => heard.push(n));
		const ev = (kind: "press" | "drag" | "release", x: number, y: number) =>
			handleMouse({ kind, button: 0, x, y, shift: false, alt: false, ctrl: false });
		ev("press", 6, 0);
		ev("drag", 3, 1);
		expect(ev("release", 3, 1)).toBe("copy");
		expect(copied).toEqual(["world\nseco"]);
		expect(heard).toEqual([10]);
		off();
		setSelectionIO(null, null);
	});

	test("selectText trims each row and follows the drag either way", () => {
		expect(selectText("ab  \ncd", { x0: 0, y0: 0, x1: 1, y1: 1 })).toBe("ab\ncd");
		expect(selectText("abcdef", { x0: 4, y0: 0, x1: 1, y1: 0 })).toBe("bcde");
		// A wide character takes two cells: column 2 is "b".
		expect(selectText("中b", { x0: 2, y0: 0, x1: 2, y1: 0 })).toBe("b");
	});

	test("key caps map to the bytes their key sends", () => {
		expect(keyBytes("^P")).toBe("\x10");
		expect(keyBytes("⇧Tab")).toBe("\x1b[Z");
		expect(keyBytes("Space ▶❚")).toBe(" ");
		expect(keyBytes("N ▶▶")).toBe("n");
		expect(keyBytes("Esc")).toBe("\x1b");
		expect(keyBytes("↑↓")).toBeNull();
	});
});
