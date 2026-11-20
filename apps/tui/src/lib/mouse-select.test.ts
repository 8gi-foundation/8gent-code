/**
 * Select and copy on macOS terminals (#5094). Mouse reporting hands every
 * drag to the app, so the default asks for none: it enters the alternate
 * screen with alternate scroll (the wheel arrives as arrows), and a burst of
 * arrows with an empty input scrolls the chat. Full reporting stays behind
 * an owner switch. These tests drive installMouse the way index.tsx does.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	DISABLE_MOUSE,
	DISABLE_SELECT,
	ENABLE_MOUSE,
	ENABLE_SELECT,
	_disposeMouse,
	arrowsToWheel,
	installMouse,
	mouseCaptureOn,
	mouseMode,
	onMouse,
	setWheelInputEmpty,
} from "./mouse-input";

class FakeStdin extends EventEmitter {
	isTTY = true;
	private buf: string[] = [];
	push(c: string) {
		this.buf.push(c);
	}
	read() {
		return this.buf.length ? (this.buf.shift() as string) : null;
	}
}
class FakeStdout {
	written = "";
	write(s: string) {
		this.written += s;
		return true;
	}
}
const drain = (s: FakeStdin) => {
	let out = "";
	for (let c = s.read(); c != null; c = s.read()) out += c;
	return out;
};
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TTY = { TERM: "xterm-256color" };

afterEach(() => {
	_disposeMouse();
	setWheelInputEmpty(true);
});

describe("mouseMode", () => {
	test("default on macOS is select: Terminal.app and iTerm select and copy on their own (#181)", () => {
		expect(mouseMode(TTY, true, null, undefined, false, "darwin")).toBe("select");
	});
	test("full reporting on macOS is still one switch away", () => {
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "1" }, true, null, undefined, false, "darwin")).toBe(
			"full",
		);
		expect(mouseMode(TTY, true, null, true, false, "darwin")).toBe("full");
	});
	test("default on other desktops stays select: the terminal selects and copies", () => {
		expect(mouseMode(TTY, true, null, undefined, false, "linux")).toBe("select");
		expect(mouseMode(TTY, true, null, undefined, false, "win32")).toBe("select");
	});
	test("select stays available on macOS as an opt-out: env, config or Settings", () => {
		expect(
			mouseMode({ ...TTY, EIGHT_MOUSE: "select" }, true, null, undefined, false, "darwin"),
		).toBe("select");
		expect(mouseMode(TTY, true, "select", undefined, false, "darwin")).toBe("select");
		expect(mouseMode(TTY, true, null, false, false, "darwin")).toBe("select");
	});
	test("off stays off on macOS", () => {
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "0" }, true, null, undefined, false, "darwin")).toBe(
			"off",
		);
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "off" }, true, null, undefined, false, "darwin")).toBe(
			"off",
		);
		expect(mouseMode(TTY, true, "off", undefined, false, "darwin")).toBe("off");
	});
	test("default on Android/Termux keeps full reporting, so tap targets and haptics stay", () => {
		expect(mouseMode(TTY, true, null, undefined, true)).toBe("full");
		expect(mouseMode({ ...TTY, TERMUX_VERSION: "0.118" }, true, null, undefined)).toBe("full");
	});
	test("the owner switch overrides the platform default either way", () => {
		expect(mouseMode(TTY, true, null, false, true)).toBe("select");
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "select" }, true, null, undefined, true)).toBe(
			"select",
		);
		expect(mouseMode(TTY, true, "select", undefined, true)).toBe("select");
		expect(mouseMode(TTY, true, null, true, false)).toBe("full");
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "0" }, true, null, undefined, true)).toBe("off");
	});
	test("full only by an explicit owner switch: env, config or setting", () => {
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "1" }, true, null, false)).toBe("full");
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "full" }, true, null, false)).toBe("full");
		expect(mouseMode(TTY, true, "on", false)).toBe("full");
		expect(mouseMode(TTY, true, null, true)).toBe("full");
	});
	test("off wins over every on switch, and for non-TTY, dumb and screen readers", () => {
		expect(mouseMode({ ...TTY, EIGHT_MOUSE: "0" }, true, null, true)).toBe("off");
		expect(mouseMode(TTY, true, "off", true)).toBe("off");
		expect(mouseMode(TTY, false, null, false)).toBe("off");
		expect(mouseMode({ TERM: "dumb" }, true, null, false)).toBe("off");
		expect(mouseMode({ ...TTY, INK_SCREEN_READER: "true" }, true, null, false)).toBe("off");
	});
});

describe("escape sequences on start and exit", () => {
	test("off mode writes nothing, on start or exit", () => {
		const out = new FakeStdout();
		const inst = installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, {
			mode: "off",
			processHooks: false,
		});
		expect(inst).toBeNull();
		expect(out.written).toBe("");
	});
	test("select mode asks for no mouse reporting at all", () => {
		const out = new FakeStdout();
		const inst = installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, {
			mode: "select",
			processHooks: false,
		});
		expect(out.written).toBe(ENABLE_SELECT);
		for (const n of ["1000", "1002", "1003", "1006"]) expect(out.written).not.toContain(`?${n}h`);
		expect(out.written).toContain("\x1b[?1049h");
		expect(out.written).toContain("\x1b[?1007h");
		inst?.dispose();
		expect(out.written.endsWith(DISABLE_SELECT + DISABLE_SELECT)).toBe(true);
		expect(out.written).not.toContain(DISABLE_MOUSE);
	});

	test("full mode writes the reporting modes and undoes exactly those", () => {
		const out = new FakeStdout();
		const inst = installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, {
			mode: "full",
			processHooks: false,
		});
		expect(out.written).toBe(ENABLE_MOUSE);
		expect(out.written).not.toContain("?1007h");
		inst?.dispose();
		expect(out.written.endsWith(DISABLE_MOUSE + DISABLE_MOUSE)).toBe(true);
	});

	test("off writes nothing and installs nothing", () => {
		const out = new FakeStdout();
		expect(
			installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, { mode: "off" }),
		).toBeNull();
		expect(out.written).toBe("");
	});

	test("the macOS default writes no reporting sequence at startup (#181)", () => {
		const out = new FakeStdout();
		installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, {
			mode: mouseMode(TTY, true, null, undefined, false, "darwin"),
			processHooks: false,
		});
		for (const n of ["1000", "1002", "1003", "1006", "1015"]) {
			expect(out.written).not.toContain(`?${n}h`);
		}
	});

	// Each exit path writes the reset. A dummy listener keeps the layer from
	// re-raising the signal at the test process once its own handler steps aside.
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
		for (const mode of ["select", "full"] as const) {
			test(`${sig} restores the terminal in ${mode} mode`, () => {
				const out = new FakeStdout();
				const keep = () => {};
				process.on(sig, keep);
				try {
					installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, { mode });
					(process as unknown as EventEmitter).emit(sig);
					const off = mode === "full" ? DISABLE_MOUSE : DISABLE_SELECT;
					expect(out.written.endsWith(off + off)).toBe(true);
				} finally {
					process.removeListener(sig, keep);
				}
			});
		}
	}

	test("a normal exit restores the terminal, in both modes", () => {
		for (const [mode, off] of [
			["select", DISABLE_SELECT],
			["full", DISABLE_MOUSE],
		] as const) {
			const out = new FakeStdout();
			installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, { mode });
			(process as unknown as EventEmitter).emit("exit", 0);
			expect(out.written.endsWith(off + off)).toBe(true);
			_disposeMouse();
		}
	});

	test("a crash restores the terminal in full mode too", () => {
		const out = new FakeStdout();
		installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, { mode: "full" });
		(process as unknown as EventEmitter).emit("uncaughtExceptionMonitor", new Error("boom"));
		expect(out.written.endsWith(DISABLE_MOUSE + DISABLE_MOUSE)).toBe(true);
	});

	test("a crash restores the terminal in select mode too", () => {
		const out = new FakeStdout();
		installMouse(new FakeStdin() as unknown as NodeJS.ReadStream, out, { mode: "select" });
		(process as unknown as EventEmitter).emit("uncaughtExceptionMonitor", new Error("boom"));
		expect(out.written.endsWith(DISABLE_SELECT + DISABLE_SELECT)).toBe(true);
	});
});

describe("wheel as arrows", () => {
	test("a burst of arrows with an empty input becomes wheel events and never reaches Ink", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			mode: "select",
			processHooks: false,
		});
		const seen: Array<[string, number]> = [];
		onMouse((e) => seen.push([e.kind, e.button]));
		stdin.push(`${UP}${UP}${DOWN}${DOWN}${DOWN}`);
		expect(drain(stdin)).toBe("");
		expect(seen).toEqual([
			["wheel", 0],
			["wheel", 0],
			["wheel", 1],
			["wheel", 1],
			["wheel", 1],
		]);
	});

	test("a lone arrow is a key: input history still works", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			mode: "select",
			processHooks: false,
		});
		const seen: string[] = [];
		onMouse((e) => seen.push(e.kind));
		stdin.push(UP);
		expect(drain(stdin)).toBe(UP);
		stdin.push(DOWN);
		expect(drain(stdin)).toBe(DOWN);
		expect(seen).toEqual([]);
	});

	test("with text in the input, arrows are never taken", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			mode: "select",
			processHooks: false,
		});
		setWheelInputEmpty(false);
		stdin.push(`${UP}${UP}${UP}`);
		expect(drain(stdin)).toBe(`${UP}${UP}${UP}`);
	});

	test("typing around a burst keeps every typed byte, in order", () => {
		setWheelInputEmpty(true);
		const r = arrowsToWheel(`ab${UP}${UP}cd`);
		expect(r.pass).toBe("abcd");
		expect(r.events.length).toBe(2);
	});

	test("full mode leaves arrows alone: reporting carries the wheel", () => {
		const stdin = new FakeStdin();
		installMouse(stdin as unknown as NodeJS.ReadStream, new FakeStdout(), {
			mode: "full",
			processHooks: false,
		});
		stdin.push(`${UP}${UP}`);
		expect(drain(stdin)).toBe(`${UP}${UP}`);
	});
});

describe("Settings row default (#181)", () => {
	test("with no setting stored the row reads Off on macOS and On on Termux", () => {
		expect(mouseCaptureOn(undefined, false)).toBe(false);
		expect(mouseCaptureOn(undefined, true)).toBe(true);
	});
	test("one press from the unset macOS state turns clicks On", () => {
		const shown = mouseCaptureOn(undefined, false);
		const afterPress = mouseCaptureOn(!shown, false);
		expect(afterPress).toBe(true);
		expect(mouseMode(TTY, true, null, afterPress, false, "darwin")).toBe("full");
	});
	test("the row and mouseMode agree for every stored value and host", () => {
		for (const stored of [undefined, true, false]) {
			for (const android of [false, true]) {
				const mode = mouseMode(TTY, true, null, stored, android, "darwin");
				expect(mouseCaptureOn(stored, android)).toBe(mode === "full");
			}
		}
	});
});
