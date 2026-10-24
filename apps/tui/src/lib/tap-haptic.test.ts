/**
 * Tap targets and haptics (#4922). James on a phone in Termux: every control
 * answers a thumb the way its key does, shows a brief pressed state, and
 * ticks if the phone already has termux-vibrate. A tap arrives as an SGR
 * mouse report, so each control is driven with real SGR bytes through the
 * same filter the TUI installs.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DJ_KEYS } from "../components/DjDeck.js";
import { APPROVAL_KEYS } from "../components/InlineApprovalPrompt.js";
import { keyCapSpans } from "../components/KeyCap.js";
import { FOOTER_HINTS, type FooterSegment, footerClickSpans } from "../components/StatusFooter.js";
import { cellSpans } from "../components/TabBar.js";
import {
	type ClickSpan,
	MIN_TAP_CELLS,
	PRESS_HOLD_MS,
	clearTargets,
	closeGaps,
	currentPressed,
	handleMouse,
	hitTest,
	placeSpans,
	setHapticDeps,
} from "./click-targets.js";
import { keyBytes } from "./key-bytes.js";
import { MouseFilter, _disposeMouse, injectKeys, installMouse } from "./mouse-input.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the app would read from stdin after injectKeys: the key bytes a tap stands in for. */
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

const injected: string[] = [];
beforeAll(() => {
	_disposeMouse();
	const stdin = new FakeStdin();
	const inst = installMouse(
		stdin as unknown as NodeJS.ReadStream,
		{ write: () => true },
		{ enabled: true, processHooks: false },
	);
	const orig = inst?.inject.bind(inst);
	if (inst && orig) {
		inst.inject = (b: string) => {
			injected.push(b);
			orig(b);
		};
	}
});

afterEach(() => {
	clearTargets();
	setHapticDeps(null);
	injected.length = 0;
});

/** One tap as a terminal reports it: press then release, 1-based cells. */
async function tap(x: number, y = 0) {
	const f = new MouseFilter();
	const out = f.feed(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
	for (const e of out.events) handleMouse(e);
}

const noop = () => {};
const row = (spans: ClickSpan[], boxW = 200, z = 0) =>
	placeSpans({ x: 0, y: 0, w: boxW, h: 1 }, spans, z);

describe("every control: SGR tap at the first, centre and last cell does what its key does", () => {
	type Control = { name: string; spans: () => ClickSpan[]; keyFor: (id: string) => string | null };
	const hints = FOOTER_HINTS.map((h) => h);
	const controls: Control[] = [
		{
			name: "footer key hints",
			spans: () => footerClickSpans([], hints, false).hints,
			keyFor: (id) => keyBytes(id.replace("footer:hint:", "").split(" ")[0] ?? ""),
		},
		{
			name: "footer segment with a key (perm)",
			spans: () => {
				const segs = [
					{ key: "model", value: "qwen3", hint: undefined },
					{ key: "perm", label: "perm", value: "Infinite", hint: "⇧Tab" },
				] as unknown as FooterSegment[];
				return footerClickSpans(segs, [], false).segments;
			},
			keyFor: () => "\x1b[Z",
		},
		{
			name: "DJ mini player keys",
			spans: () =>
				keyCapSpans(
					DJ_KEYS.map((k, i) => ({ cap: k.cap, verb: k.verb, gap: i ? 2 : 5 })),
					"dj",
				),
			keyFor: (id) => keyBytes(id.replace("dj:", "")),
		},
		{
			name: "DJ mini player keys, phone layout",
			spans: () =>
				keyCapSpans(
					[DJ_KEYS[1], DJ_KEYS[2], DJ_KEYS[3], DJ_KEYS[7]].map((k, i) => ({
						cap: k.cap,
						verb: "",
						gap: i ? 1 : 5,
					})),
					"djn",
				),
			keyFor: (id) => keyBytes(id.replace("djn:", "")),
		},
		{
			name: "approval card",
			spans: () =>
				keyCapSpans(
					APPROVAL_KEYS.map(([cap, verb]) => ({ cap, verb })),
					"card",
				),
			keyFor: (id) => keyBytes(id.replace("card:", "")),
		},
	];

	for (const c of controls) {
		test(c.name, async () => {
			const spans = c.spans();
			expect(spans.length).toBeGreaterThan(0);
			// footerClickSpans and keyCapSpans inject through injectKeys, which the test wraps.
			// KeyCap spans take a send; rebuild them with injection so the action is the real one.
			const placed = row(spans);
			expect(placed.length).toBe(spans.length);
			for (const id of placed) {
				const t = [...Array(200).keys()].map((x) => hitTest(x, 0)).filter((h) => h?.id === id);
				expect(t.length).toBeGreaterThanOrEqual(MIN_TAP_CELLS);
				const cells = [...Array(200).keys()].filter((x) => hitTest(x, 0)?.id === id);
				const first = cells[0] as number;
				const last = cells[cells.length - 1] as number;
				const centre = cells[Math.floor(cells.length / 2)] as number;
				for (const x of [first, centre, last]) {
					injected.length = 0;
					await tap(x);
					expect(injected).toEqual([c.keyFor(id) as string]);
				}
			}
		});
	}
});

describe("minimum tap width", () => {
	const span = (id: string, dx: number, w: number): ClickSpan => ({ id, dx, w, action: noop });

	test("a one-cell span grows to three, taking free cells to its right first", () => {
		const out = closeGaps([span("a", 0, 1), span("b", 20, 4)]);
		expect(out[0]).toMatchObject({ dx: 0, w: MIN_TAP_CELLS });
	});

	test("it never grows over a neighbour, and borrows the left when the right is taken", () => {
		const out = closeGaps([span("a", 0, 3), span("b", 3, 1)]);
		expect(out.map((s) => [s.id, s.dx, s.w])).toEqual([
			["a", 0, 3],
			["b", 3, 3],
		]);
		const tight = closeGaps([span("a", 0, 5), span("b", 5, 1), span("c", 6, 4)]);
		const b = tight.find((s) => s.id === "b") as ClickSpan;
		expect(b.w).toBeGreaterThanOrEqual(1);
		const sorted = [...tight].sort((p, q) => p.dx - q.dx);
		for (let i = 0; i + 1 < sorted.length; i++)
			expect((sorted[i] as ClickSpan).dx + (sorted[i] as ClickSpan).w).toBeLessThanOrEqual(
				(sorted[i + 1] as ClickSpan).dx,
			);
	});

	test("every span the HUD builds is at least three cells once placed", () => {
		const groups = [
			footerClickSpans([], FOOTER_HINTS, false).hints,
			keyCapSpans(
				DJ_KEYS.map((k) => ({ cap: k.cap })),
				"dj",
				noop,
			),
			cellSpans([{ num: "1] ", title: "A", active: true }]).map((s, i) => ({
				id: `tab:${i}`,
				dx: s.x,
				w: s.width,
				action: noop,
			})),
		];
		for (const g of groups)
			for (const s of closeGaps(g)) expect(s.w).toBeGreaterThanOrEqual(MIN_TAP_CELLS);
	});
});

describe("pressed state", () => {
	test("shows on press and stays about 120 ms after the release, so a quick tap is seen", async () => {
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		const f = new MouseFilter();
		for (const e of f.feed("\x1b[<0;2;1M").events) handleMouse(e);
		expect(currentPressed()).toBe("x");
		for (const e of f.feed("\x1b[<0;2;1m").events) handleMouse(e);
		expect(currentPressed()).toBe("x");
		await sleep(PRESS_HOLD_MS + 60);
		expect(currentPressed()).toBeNull();
	});

	test("a release off the target cancels at once, with no hold", () => {
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		const f = new MouseFilter();
		for (const e of f.feed("\x1b[<0;2;1M\x1b[<0;40;1m").events) handleMouse(e);
		expect(currentPressed()).toBeNull();
	});

	test("the hold is 120 ms", () => {
		expect(PRESS_HOLD_MS).toBe(120);
	});
});

describe("haptic tick", () => {
	function rig(opts: { binary: boolean; enabled: boolean }) {
		const calls: { cmd: string; args: string[] }[] = [];
		let binaryChecks = 0;
		setHapticDeps({
			spawn: (cmd, args) => {
				calls.push({ cmd, args });
			},
			hasBinary: () => {
				binaryChecks++;
				return opts.binary;
			},
			enabled: () => opts.enabled,
		});
		return { calls, checks: () => binaryChecks };
	}

	test("spawns termux-vibrate -d 20 once per tap when the binary exists and the setting is on", async () => {
		const r = rig({ binary: true, enabled: true });
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		await tap(1);
		expect(r.calls).toEqual([{ cmd: "termux-vibrate", args: ["-d", "20"] }]);
	});

	test("does nothing when the binary is not on the phone", async () => {
		const r = rig({ binary: false, enabled: true });
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		await tap(1);
		expect(r.calls).toEqual([]);
	});

	test("does nothing when the setting is off", async () => {
		const r = rig({ binary: true, enabled: false });
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		await tap(1);
		expect(r.calls).toEqual([]);
	});

	test("a tap on nothing does not vibrate", async () => {
		const r = rig({ binary: true, enabled: true });
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		await tap(50);
		expect(r.calls).toEqual([]);
	});

	test("the binary is looked up once and cached", async () => {
		const r = rig({ binary: true, enabled: true });
		row([{ id: "x", dx: 0, w: 4, action: noop }]);
		await tap(1);
		await tap(2);
		expect(r.calls.length).toBe(2);
		expect(r.checks()).toBe(1);
	});

	test("a spawn that throws never breaks the tap", async () => {
		let ran = 0;
		setHapticDeps({
			spawn: () => {
				throw new Error("EACCES");
			},
			hasBinary: () => true,
			enabled: () => true,
		});
		row([{ id: "x", dx: 0, w: 4, action: () => ran++ }]);
		await tap(1);
		expect(ran).toBe(1);
	});
});
