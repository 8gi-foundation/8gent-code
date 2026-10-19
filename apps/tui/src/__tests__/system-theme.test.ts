/**
 * The opt-in `system` theme (#4440): the palette probe (OSC 10, OSC 4, DEC
 * 2031), stray replies never reaching the input, a silent terminal falling
 * back inside the cap, the palette fit (4.5:1 on 6 terminals, the user's hues
 * passing through), and the default theme staying exactly as it was.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { fromHex, rgbToOklch } from "../../../../packages/design-compose/index.js";
import { palettes, themeChoices } from "../theme.js";
import {
	SYSTEM_ID,
	TEXT_ROLES,
	contrastHex,
	findDesignSystem,
	fitPaletteToBackground,
	paletteFromTerminal,
	perceptuallyBanned,
} from "../theme/design-systems.js";
import {
	DA1_QUERY,
	FOLLOW_TIMEOUT_MS,
	OSC11_QUERY,
	PALETTE_QUERY,
	ReplyFilter,
	SCHEME_SUBSCRIBE,
	SCHEME_SUPPORT_QUERY,
	followTerminalScheme,
	parseTerminalReport,
	probeTerminalBackground,
	splitTrailingPartial,
	stripReplies,
} from "../theme/terminal-probe.js";

const ESC = "\x1b";
const BEL = "\x07";
const osc = (id: string, rgb: string) => `${ESC}]${id};rgb:${rgb}${BEL}`;
const SCHEME_SUPPORTED = `${ESC}[?2031;2$y`;
const DA1_REPLY = `${ESC}[?62;22c`;

describe("parseTerminalReport", () => {
	test("reads OSC 4 slots, OSC 10, OSC 11 and DEC 2031 support", () => {
		const r = parseTerminalReport(
			osc("11", "0a0a/0909/0808") +
				osc("10", "fafa/f7f7/f4f4") +
				osc("4;1", "e5e5/5050/3a3a") +
				osc("4;15", "ffff/ffff/ffff") +
				SCHEME_SUPPORTED +
				DA1_REPLY,
		);
		expect(r.bg).toBe("#0a0908");
		expect(r.fg).toBe("#faf7f4");
		expect(r.ansi[1]).toBe("#e5503a");
		expect(r.ansi[15]).toBe("#ffffff");
		expect(r.ansi[2]).toBeNull();
		expect(r.schemeNotify).toBe(true);
	});
	test("DECRPM Ps 0 (unknown mode) is not support; malformed and out-of-range slots are ignored", () => {
		expect(parseTerminalReport(`${ESC}[?2031;0$y`).schemeNotify).toBe(false);
		const r = parseTerminalReport(
			osc("4;16", "0/0/0") + osc("4;3", "1/2/3/4") + `${ESC}]4;3;rgb:0/0/0`,
		);
		expect(r.ansi.every((a) => a === null)).toBe(true);
	});
	test("a silent terminal gives an all-null report", () => {
		const r = parseTerminalReport("");
		expect(r).toEqual({ bg: null, fg: null, ansi: new Array(16).fill(null), schemeNotify: false });
	});
});

describe("stray replies never reach the input box", () => {
	test("stripReplies removes every reply form and keeps typed text", () => {
		const all =
			osc("4;7", "1/2/3") + osc("10", "f/f/f") + SCHEME_SUPPORTED + `${ESC}[?997;1n` + DA1_REPLY;
		expect(stripReplies(`a${all}b`)).toBe("ab");
	});
	test("a reply cut across reads is held, then dropped", () => {
		const f = new ReplyFilter();
		expect(f.push(`hi${ESC}]4;3;rgb:ff`)).toBe("hi");
		expect(f.push(`ff/0/0${BEL}!`)).toBe("!");
		expect(f.push(`${ESC}[?997;`)).toBe("");
		expect(f.push("2nx")).toBe("x");
		expect(splitTrailingPartial(`${ESC}[?2031;2$`)).toEqual(["", `${ESC}[?2031;2$`]);
	});
	test("an arrow key and the Escape key are never held", () => {
		const f = new ReplyFilter();
		expect(f.push(`${ESC}[A`)).toBe(`${ESC}[A`);
		expect(f.push(ESC)).toBe(ESC);
	});
});

class FakeStdin extends EventEmitter {
	isTTY = true;
	isRaw = false;
	queue: Buffer[] = [];
	setRawMode(m: boolean) {
		this.isRaw = m;
		return this;
	}
	resume() {
		return this;
	}
	pause() {
		return this;
	}
	unshift(c: Buffer | string) {
		this.queue.unshift(Buffer.from(c));
	}
	read() {
		return this.queue.shift() ?? null;
	}
	feed(s: string) {
		this.queue.push(Buffer.from(s));
	}
}
const asStdin = (s: FakeStdin) => s as unknown as NodeJS.ReadableStream & { isTTY: boolean };
function fakeStdout(onWrite?: (s: string) => void) {
	const writes: string[] = [];
	return {
		isTTY: true,
		writes,
		write(s: string) {
			writes.push(s);
			onWrite?.(s);
			return true;
		},
	};
}

describe("palette probe", () => {
	test("palette mode asks once, waits for DA1, and reads every reply before it", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() =>
			queueMicrotask(() => {
				stdin.emit("data", Buffer.from(osc("11", "0a0a/0909/0808") + osc("10", "fafa/f7f7/f4f4")));
				stdin.emit(
					"data",
					Buffer.from(osc("4;3", "e8e8/6161/0a0a") + SCHEME_SUPPORTED + DA1_REPLY),
				);
			}),
		);
		const bg = await probeTerminalBackground({
			stdin: asStdin(stdin),
			stdout,
			env: {},
			palette: true,
		});
		expect(bg).toBe("#0a0908");
		expect(stdout.writes).toEqual([OSC11_QUERY + PALETTE_QUERY + SCHEME_SUPPORT_QUERY + DA1_QUERY]);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("without the flag the bytes written are exactly what they were (no added startup cost)", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() =>
			queueMicrotask(() => stdin.emit("data", Buffer.from(osc("11", "0/0/0") + DA1_REPLY))),
		);
		await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} });
		expect(stdout.writes).toEqual([OSC11_QUERY + DA1_QUERY]);
	});

	test("a terminal or tmux that swallows the queries times out inside 150 ms and returns null", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		const t0 = performance.now();
		const bg = await probeTerminalBackground({
			stdin: asStdin(stdin),
			stdout,
			env: {},
			palette: true,
		});
		expect(bg).toBeNull();
		expect(performance.now() - t0).toBeLessThan(150);
	});

	test("no TTY, or EIGHT_OSC11=0, writes nothing", async () => {
		const stdin = new FakeStdin();
		stdin.isTTY = false;
		const out = fakeStdout();
		expect(
			await probeTerminalBackground({ stdin: asStdin(stdin), stdout: out, env: {}, palette: true }),
		).toBeNull();
		const stdin2 = new FakeStdin();
		expect(
			await probeTerminalBackground({
				stdin: asStdin(stdin2),
				stdout: out,
				env: { EIGHT_OSC11: "0" },
				palette: true,
			}),
		).toBeNull();
		expect(out.writes).toEqual([]);
		expect(
			followTerminalScheme(() => {}, { stdin: asStdin(stdin), stdout: out, env: {} }),
		).toBeNull();
	});
});

describe("followTerminalScheme", () => {
	test("a 2031 notice re-asks, the reply is stripped from stdin and reported, and 2031 is subscribed", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		const reports: string[] = [];
		const f = followTerminalScheme((r) => reports.push(r.bg ?? ""), {
			stdin: asStdin(stdin),
			stdout,
			env: {},
		});
		expect(f).not.toBeNull();
		// Notice arrives; the filter swallows it and writes the query.
		stdin.feed(`${ESC}[?997;2n`);
		expect(stdin.read()).toBeNull();
		expect(stdout.writes).toEqual([OSC11_QUERY + PALETTE_QUERY + SCHEME_SUPPORT_QUERY + DA1_QUERY]);
		// The answer, with a typed key in the same chunk.
		stdin.feed(`k${osc("11", "fdfd/f6f6/e3e3")}${SCHEME_SUPPORTED}${DA1_REPLY}`);
		expect(stdin.read()?.toString()).toBe("k");
		expect(reports).toEqual(["#fdf6e3"]);
		expect(stdout.writes[1]).toBe(SCHEME_SUBSCRIBE);
		// A late stray reply after the window is still never typed.
		stdin.feed(osc("4;1", "1/2/3"));
		expect(stdin.read()).toBeNull();
		f?.stop();
	});

	test("a partial OSC fragment followed by silence is released as typed input within 50 ms", async () => {
		const stdin = new FakeStdin();
		const f = followTerminalScheme(() => {}, {
			stdin: asStdin(stdin),
			stdout: fakeStdout(),
			env: {},
		});
		stdin.feed(`ok${ESC}]`); // Alt+] or a pasted partial OSC
		expect(stdin.read()?.toString()).toBe("ok");
		expect(stdin.read()).toBeNull();
		await new Promise((r) => setTimeout(r, 90));
		expect(stdin.read()?.toString()).toBe(`${ESC}]`);
		expect(stdin.read()).toBeNull();
		f?.stop();
	});

	test("system, another theme, system again: the second follower still reports", () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		const opts = { stdin: asStdin(stdin), stdout, env: {} };
		const first = followTerminalScheme(() => {}, opts);
		first?.stop();
		const reports: string[] = [];
		const second = followTerminalScheme((r) => reports.push(r.bg ?? ""), opts);
		second?.refresh();
		stdin.feed(`${osc("11", "fdfd/f6f6/e3e3")}${DA1_REPLY}`);
		expect(stdin.read()).toBeNull();
		expect(reports).toEqual(["#fdf6e3"]);
		second?.stop();
	});

	test("silence after a notice reports nothing within the timeout", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		let n = 0;
		const f = followTerminalScheme(() => n++, {
			stdin: asStdin(stdin),
			stdout,
			env: {},
			timeoutMs: 20,
		});
		f?.refresh();
		await new Promise((r) => setTimeout(r, 40));
		expect(n).toBe(0);
		expect(FOLLOW_TIMEOUT_MS).toBeLessThanOrEqual(150);
		f?.stop();
	});
});

// Six fixture terminals: 3 light, 3 dark. Slots not listed are unanswered.
interface Fixture {
	bg: string;
	fg: string;
	ansi: Record<number, string>;
}
const FIXTURES: Record<string, Fixture> = {
	"solarized dark": {
		bg: "#002b36",
		fg: "#839496",
		ansi: { 1: "#dc322f", 2: "#859900", 3: "#b58900", 4: "#268bd2", 6: "#2aa198", 8: "#586e75" },
	},
	"one dark": {
		bg: "#282c34",
		fg: "#abb2bf",
		ansi: { 1: "#e06c75", 2: "#98c379", 3: "#e5c07b", 4: "#61afef", 6: "#56b6c2", 8: "#5c6370" },
	},
	"violet night (hues 270 to 350)": {
		bg: "#1a1423",
		fg: "#cdbfe6",
		ansi: {
			1: "#d9534f",
			2: "#6fbf73",
			3: "#c792ea",
			4: "#a37bd8",
			5: "#e0709f",
			6: "#7fd1c9",
			8: "#6b5c85",
		},
	},
	"solarized light": {
		bg: "#fdf6e3",
		fg: "#657b83",
		ansi: { 1: "#dc322f", 2: "#859900", 3: "#b58900", 4: "#268bd2", 6: "#2aa198", 8: "#93a1a1" },
	},
	"paper white": {
		bg: "#ffffff",
		fg: "#444444",
		ansi: { 1: "#c91b00", 2: "#00c200", 3: "#c7c400", 4: "#0225c7", 6: "#00c5c7", 8: "#686868" },
	},
	"lavender light (hues 270 to 350)": {
		bg: "#f5f0ff",
		fg: "#4a3b6b",
		ansi: { 1: "#c0392b", 2: "#2e8b57", 3: "#9b59b6", 4: "#7e57c2", 6: "#3f9fa8", 8: "#8a7fa5" },
	},
};
const asColors = (f: Fixture) => ({
	fg: f.fg,
	ansi: Array.from({ length: 16 }, (_, i) => f.ansi[i] ?? null),
});
const stockFor = (bg: string) =>
	contrastHex(bg, "#000000") > contrastHex(bg, "#ffffff") ? palettes.light : palettes.dark;

describe("paletteFromTerminal", () => {
	for (const [name, f] of Object.entries(FIXTURES)) {
		test(`${name}: every text role clears 4.5:1, the frame 3:1`, () => {
			const p = paletteFromTerminal({ ...stockFor(f.bg) }, asColors(f), f.bg);
			const failures = TEXT_ROLES.filter((r) => contrastHex(p[r], f.bg) < 4.5).map(
				(r) => `${r} ${p[r]}`,
			);
			expect(failures).toEqual([]);
			expect(contrastHex(p.frame, f.bg)).toBeGreaterThanOrEqual(3);
			expect(contrastHex(p.textPrimary, p.border)).toBeGreaterThanOrEqual(4.5);
			expect(p.bg).toBe(f.bg);
		});
	}

	test("hues from the terminal pass through unchanged, even inside 270 to 350", () => {
		const f = FIXTURES["violet night (hues 270 to 350)"] as Fixture;
		const p = paletteFromTerminal({ ...palettes.dark }, asColors(f), f.bg);
		const hue = (hex: string) => rgbToOklch(fromHex(hex)).h;
		const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
		// ansi 3 is #c792ea (a violet): orange takes its hue, only lightness moved.
		expect(dist(hue(p.orange), hue("#c792ea"))).toBeLessThan(3);
		expect(dist(hue(p.steel), hue("#a37bd8"))).toBeLessThan(3);
		expect(perceptuallyBanned(p.orange)).toBe(true); // the user's own choice, kept on purpose
	});

	test("a terminal that reported nothing gives the stock theme, fitted, never banned", () => {
		const none = paletteFromTerminal(
			{ ...palettes.dark },
			{ fg: null, ansi: new Array(16).fill(null) },
			"#0A0908",
		);
		expect(none).toEqual(fitPaletteToBackground({ ...palettes.dark }, "#0A0908"));
		expect(paletteFromTerminal({ ...palettes.light }, null, "#FAF7F4")).toEqual(
			fitPaletteToBackground({ ...palettes.light }, "#FAF7F4"),
		);
		for (const role of TEXT_ROLES) expect(perceptuallyBanned(none[role])).toBe(false);
	});

	test("danger red and success green keep their meaning: a far-off terminal slot is ignored", () => {
		const f = { bg: "#0A0908", fg: "#cccccc", ansi: { 1: "#3fa0e0", 2: "#e0503f" } } as Fixture;
		const p = paletteFromTerminal({ ...palettes.dark }, asColors(f), f.bg);
		const base = fitPaletteToBackground({ ...palettes.dark }, f.bg);
		expect(p.red).toBe(base.red);
		expect(p.green).toBe(base.green);
	});
});

describe("opt-in wiring", () => {
	test("system is a known id for the saved choice and /theme, and the default is unchanged", () => {
		expect(findDesignSystem(SYSTEM_ID)?.label).toBe("System");
		expect(findDesignSystem("System")?.id).toBe("system");
	});
	test("the picker lists it after the stock theme and previews it with stock colours, not the user's hues", () => {
		const rows = themeChoices();
		const sys = rows.find((r) => r.value === SYSTEM_ID);
		expect(sys).toBeDefined();
		expect(rows[0]?.value).toBe("default");
		expect(sys?.swatches).toEqual(rows[0]?.swatches);
	});
});
