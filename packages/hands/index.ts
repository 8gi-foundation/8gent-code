/**
 * @8gent/hands - macOS desktop driver.
 *
 * Pattern adapted from trycua/cua (MIT) - concept only, not code:
 *   - One driver object exposing screenshot/click/type/scroll/drag/hover/keys.
 *   - Screenshot returns a real PNG buffer plus a path on disk.
 *   - Mouse / keyboard delegated to the lightest tool available
 *     (`cliclick` if installed, AppleScript via `osascript` as fallback).
 *
 * No native modules, no Swift bridge yet, no daemon socket. This driver is the
 * physical layer the Computer tool surface (packages/computer/bridge.ts) calls
 * once policy has approved an action.
 *
 * Failure mode: if `cliclick` is missing AND osascript also fails, the driver
 * returns `{ ok: false, error }` instead of throwing. The agent loop survives;
 * the user sees a clean error string.
 *
 * Closes #1908.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Capability detection (run once)
// ============================================================================

interface Capabilities {
	cliclick: string | null; // path or null
	screencapture: boolean;
	osascript: boolean;
}

function which(bin: string): string | null {
	const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf-8" });
	if (r.status !== 0) return null;
	const out = r.stdout.trim();
	return out.length > 0 ? out : null;
}

let _caps: Capabilities | null = null;
function caps(): Capabilities {
	if (_caps) return _caps;
	_caps = {
		cliclick: which("cliclick"),
		screencapture: existsSync("/usr/sbin/screencapture"),
		osascript: existsSync("/usr/bin/osascript"),
	};
	return _caps;
}

// ============================================================================
// Types (shared shape with packages/computer/types.ts so the bridge can import)
// ============================================================================

export interface Point {
	x: number;
	y: number;
}
export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ScreenshotOpts {
	path?: string;
	displayId?: number;
	region?: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotOut {
	ok: boolean;
	path: string;
	buffer?: Buffer;
	width?: number;
	height?: number;
	error?: string;
}

export interface OpResult {
	ok: boolean;
	error?: string;
}

export interface HandsDriver {
	readonly id: string;
	readonly available: boolean;
	readonly capabilities: Readonly<Capabilities>;
	screenshot(opts?: ScreenshotOpts): ScreenshotOut;
	click(p: Point, button?: MouseButton, count?: number): OpResult;
	type(text: string, delayMs?: number): OpResult;
	press(keys: string): OpResult;
	scroll(direction: ScrollDirection, amount: number, anchor?: Point): OpResult;
	drag(from: Point, to: Point, button?: MouseButton, durationMs?: number): OpResult;
	hover(p: Point): OpResult;
	mousePosition(): { ok: boolean; point?: Point; error?: string };
	clipboardGet(): { ok: boolean; text?: string; error?: string };
	clipboardSet(text: string): OpResult;
	windowList(): { ok: boolean; windows?: WindowInfo[]; error?: string };
}

export interface WindowInfo {
	id: number;
	title: string;
	app: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

// ============================================================================
// Helpers
// ============================================================================

function runFile(
	cmd: string,
	args: string[],
	timeoutMs = 10_000,
): { ok: boolean; stdout: string; stderr: string } {
	try {
		const out = execFileSync(cmd, args, {
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: out, stderr: "" };
	} catch (err: any) {
		return {
			ok: false,
			stdout: err?.stdout?.toString() ?? "",
			stderr: err?.stderr?.toString() ?? err?.message ?? "command failed",
		};
	}
}

function osa(script: string): { ok: boolean; out: string; err?: string } {
	const r = runFile("/usr/bin/osascript", ["-e", script]);
	if (!r.ok) return { ok: false, out: "", err: r.stderr || "osascript failed" };
	return { ok: true, out: r.stdout.trim() };
}

// Map our key combo strings ("cmd+s", "ctrl+shift+p", "enter") to cliclick syntax.
// cliclick uses kp:<keyname> for single keys and kd/ku for modifiers.
const KEY_ALIASES: Record<string, string> = {
	enter: "return",
	return: "return",
	esc: "esc",
	escape: "esc",
	tab: "tab",
	space: "space",
	backspace: "delete",
	delete: "fwd-delete",
	up: "arrow-up",
	down: "arrow-down",
	left: "arrow-left",
	right: "arrow-right",
	home: "home",
	end: "end",
	pageup: "page-up",
	pagedown: "page-down",
};

const MODIFIERS = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "shift", "fn"]);
const MOD_TO_CLICLICK: Record<string, string> = {
	cmd: "cmd",
	command: "cmd",
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	option: "alt",
	shift: "shift",
	fn: "fn",
};

function pressViaCliclick(cliclick: string, combo: string): OpResult {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map((s) => s.trim())
		.filter(Boolean);
	const mods: string[] = [];
	let key = "";
	for (const p of parts) {
		if (MODIFIERS.has(p)) mods.push(MOD_TO_CLICLICK[p] ?? p);
		else key = KEY_ALIASES[p] ?? p;
	}
	if (!key) return { ok: false, error: `press: no key in combo "${combo}"` };

	// cliclick: hold modifier(s), tap key, release
	const cmds: string[] = [];
	if (mods.length > 0) cmds.push(`kd:${mods.join(",")}`);
	// single-character non-special keys go through `t:` (type) so cliclick treats
	// them as text input under the held modifier (e.g. cmd+s).
	if (key.length === 1) cmds.push(`t:${key}`);
	else cmds.push(`kp:${key}`);
	if (mods.length > 0) cmds.push(`ku:${mods.join(",")}`);

	const r = runFile(cliclick, cmds);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

function pressViaOsascript(combo: string): OpResult {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map((s) => s.trim())
		.filter(Boolean);
	const mods: string[] = [];
	let key = "";
	for (const p of parts) {
		if (MODIFIERS.has(p)) {
			if (p === "cmd" || p === "command") mods.push("command down");
			else if (p === "ctrl" || p === "control") mods.push("control down");
			else if (p === "alt" || p === "option") mods.push("option down");
			else if (p === "shift") mods.push("shift down");
		} else key = p;
	}
	if (!key) return { ok: false, error: `press: no key in combo "${combo}"` };

	// Map to AppleScript key codes for special keys; otherwise use keystroke
	const keyCodes: Record<string, number> = {
		enter: 36,
		return: 36,
		tab: 48,
		space: 49,
		backspace: 51,
		esc: 53,
		escape: 53,
		up: 126,
		down: 125,
		left: 123,
		right: 124,
		home: 115,
		end: 119,
		pageup: 116,
		pagedown: 121,
		delete: 117,
	};

	const using = mods.length > 0 ? ` using {${mods.join(", ")}}` : "";
	const script =
		keyCodes[key] !== undefined
			? `tell application "System Events" to key code ${keyCodes[key]}${using}`
			: `tell application "System Events" to keystroke "${key.replace(/"/g, '\\"')}"${using}`;

	const r = osa(script);
	return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// ============================================================================
// Driver implementation
// ============================================================================

class MacosDriver implements HandsDriver {
	readonly id = "hands-macos-v0";
	readonly capabilities: Readonly<Capabilities>;
	readonly available: boolean;

	constructor() {
		this.capabilities = caps();
		// Available if we can at least screenshot and either click via cliclick or
		// fall back to osascript for keystrokes.
		this.available = this.capabilities.screencapture && this.capabilities.osascript;
	}

	screenshot(opts: ScreenshotOpts = {}): ScreenshotOut {
		if (!this.capabilities.screencapture) {
			return {
				ok: false,
				path: "",
				error: "screencapture not found at /usr/sbin/screencapture",
			};
		}
		const out = opts.path ?? join(tmpdir(), `8gent-hands-${Date.now()}.png`);
		const args = ["-x", "-t", "png"]; // -x: silent (no shutter sound)
		if (opts.displayId !== undefined) args.push("-D", String(opts.displayId + 1));
		if (opts.region) {
			args.push(
				"-R",
				`${Math.round(opts.region.x)},${Math.round(opts.region.y)},${Math.round(
					opts.region.width,
				)},${Math.round(opts.region.height)}`,
			);
		}
		args.push(out);

		const r = runFile("/usr/sbin/screencapture", args, 15_000);
		if (!r.ok || !existsSync(out)) {
			return {
				ok: false,
				path: out,
				error: r.stderr || "screencapture produced no file",
			};
		}
		let buf: Buffer | undefined;
		try {
			buf = readFileSync(out);
		} catch (e: any) {
			return { ok: false, path: out, error: e?.message ?? "read failed" };
		}
		const dims = pngDimensions(buf);
		return { ok: true, path: out, buffer: buf, width: dims?.w, height: dims?.h };
	}

	click(p: Point, button: MouseButton = "left", count = 1): OpResult {
		const x = Math.round(p.x);
		const y = Math.round(p.y);
		const cli = this.capabilities.cliclick;
		if (cli) {
			// cliclick c: left, rc: right, mc: middle. Repeat for count.
			const prefix = button === "right" ? "rc" : button === "middle" ? "mc" : "c";
			const cmds: string[] = [];
			for (let i = 0; i < count; i++) cmds.push(`${prefix}:${x},${y}`);
			const r = runFile(cli, cmds);
			return r.ok ? { ok: true } : { ok: false, error: r.stderr };
		}
		// AppleScript fallback (left-click only; right/middle not reliable via osa).
		if (button !== "left") {
			return {
				ok: false,
				error: `cliclick is not installed; install via "brew install cliclick" for ${button}-click support`,
			};
		}
		// Use cliclick-style fallback: System Events click at position
		const script = `tell application "System Events" to repeat ${count} times
  click at {${x}, ${y}}
end repeat`;
		const r = osa(script);
		return r.ok ? { ok: true } : { ok: false, error: r.err };
	}

	type(text: string, delayMs = 0): OpResult {
		if (!text) return { ok: false, error: "type: text empty" };
		const cli = this.capabilities.cliclick;
		if (cli) {
			const args: string[] = [];
			if (delayMs > 0) args.push("-w", String(delayMs));
			args.push(`t:${text}`);
			const r = runFile(cli, args, 30_000);
			return r.ok ? { ok: true } : { ok: false, error: r.stderr };
		}
		// osascript escape: backslash and double-quote
		const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = `tell application "System Events" to keystroke "${escaped}"`;
		const r = osa(script);
		return r.ok ? { ok: true } : { ok: false, error: r.err };
	}

	press(keys: string): OpResult {
		const cli = this.capabilities.cliclick;
		if (cli) return pressViaCliclick(cli, keys);
		if (this.capabilities.osascript) return pressViaOsascript(keys);
		return { ok: false, error: "no keystroke backend (install cliclick or enable osascript)" };
	}

	scroll(direction: ScrollDirection, amount: number, anchor?: Point): OpResult {
		if (anchor) {
			const mv = this.hover(anchor);
			if (!mv.ok) return mv;
		}
		const cli = this.capabilities.cliclick;
		if (cli) {
			// cliclick wheel direction: +Y down, -Y up, +X right, -X left
			let dx = 0;
			let dy = 0;
			switch (direction) {
				case "up":
					dy = -amount;
					break;
				case "down":
					dy = amount;
					break;
				case "left":
					dx = -amount;
					break;
				case "right":
					dx = amount;
					break;
			}
			// cliclick has no native wheel; use AppleScript via System Events
		}
		// AppleScript wheel via System Events (works with cliclick missing too)
		const ksMap: Record<ScrollDirection, number> = {
			up: 126,
			down: 125,
			left: 123,
			right: 124,
		};
		// Repeat arrow-key as a coarse scroll fallback so the agent never silently
		// no-ops. Real wheel events would need a small ObjC helper - tracked in a
		// follow-up issue.
		const code = ksMap[direction];
		const ticks = Math.max(1, Math.min(50, Math.round(amount)));
		const script = `tell application "System Events" to repeat ${ticks} times
  key code ${code}
end repeat`;
		const r = osa(script);
		return r.ok ? { ok: true } : { ok: false, error: r.err };
	}

	drag(from: Point, to: Point, button: MouseButton = "left", durationMs = 500): OpResult {
		if (button !== "left") {
			return { ok: false, error: "drag: only left-button drag is supported" };
		}
		const cli = this.capabilities.cliclick;
		if (!cli) {
			return {
				ok: false,
				error: "drag requires cliclick; install via \"brew install cliclick\"",
			};
		}
		// dd: drag-down (start), dm: drag-move (waypoint), du: drag-up (end)
		const fx = Math.round(from.x);
		const fy = Math.round(from.y);
		const tx = Math.round(to.x);
		const ty = Math.round(to.y);
		const args: string[] = [];
		const wait = Math.max(0, Math.min(5000, Math.round(durationMs)));
		if (wait > 0) args.push("-w", String(Math.min(1000, wait)));
		args.push(`dd:${fx},${fy}`, `dm:${tx},${ty}`, `du:${tx},${ty}`);
		const r = runFile(cli, args, 15_000);
		return r.ok ? { ok: true } : { ok: false, error: r.stderr };
	}

	hover(p: Point): OpResult {
		const x = Math.round(p.x);
		const y = Math.round(p.y);
		const cli = this.capabilities.cliclick;
		if (cli) {
			const r = runFile(cli, [`m:${x},${y}`]);
			return r.ok ? { ok: true } : { ok: false, error: r.stderr };
		}
		// No reliable AppleScript cursor-move. Report cleanly.
		return {
			ok: false,
			error: 'hover requires cliclick; install via "brew install cliclick"',
		};
	}

	mousePosition(): { ok: boolean; point?: Point; error?: string } {
		const cli = this.capabilities.cliclick;
		if (!cli) {
			return {
				ok: false,
				error: 'mousePosition requires cliclick; install via "brew install cliclick"',
			};
		}
		// `cliclick p` prints "x,y"
		const r = runFile(cli, ["p"]);
		if (!r.ok) return { ok: false, error: r.stderr };
		const m = r.stdout.trim().match(/(-?\d+),\s*(-?\d+)/);
		if (!m) return { ok: false, error: `unparsable cliclick output: ${r.stdout}` };
		return { ok: true, point: { x: Number(m[1]), y: Number(m[2]) } };
	}

	clipboardGet(): { ok: boolean; text?: string; error?: string } {
		const r = runFile("/usr/bin/pbpaste", []);
		if (!r.ok) return { ok: false, error: r.stderr };
		return { ok: true, text: r.stdout };
	}

	clipboardSet(text: string): OpResult {
		// pbcopy reads from stdin; spawnSync handles the pipe cleanly.
		const r = spawnSync("/usr/bin/pbcopy", [], { input: text, encoding: "utf-8" });
		if (r.status !== 0) {
			return { ok: false, error: r.stderr?.toString() ?? "pbcopy failed" };
		}
		return { ok: true };
	}

	windowList(): { ok: boolean; windows?: WindowInfo[]; error?: string } {
		// Lightweight AppleScript window enumeration. Returns front windows of
		// every running app that exposes a UI process. Coordinates are screen
		// space. Slow on machines with many apps; callers should cache.
		const script = `set out to ""
tell application "System Events"
  set procs to (every process whose background only is false)
  repeat with p in procs
    try
      set pname to name of p
      set wins to (every window of p)
      repeat with w in wins
        try
          set wtitle to name of w
          set wpos to position of w
          set wsize to size of w
          set out to out & pname & "\\t" & wtitle & "\\t" & (item 1 of wpos) & "\\t" & (item 2 of wpos) & "\\t" & (item 1 of wsize) & "\\t" & (item 2 of wsize) & "\\n"
        end try
      end repeat
    end try
  end repeat
end tell
return out`;
		const r = osa(script);
		if (!r.ok) return { ok: false, error: r.err };
		const lines = r.out.split("\n").filter((l) => l.trim().length > 0);
		const windows: WindowInfo[] = [];
		let id = 0;
		for (const line of lines) {
			const parts = line.split("\t");
			if (parts.length < 6) continue;
			windows.push({
				id: id++,
				app: parts[0],
				title: parts[1],
				x: Number(parts[2]) || 0,
				y: Number(parts[3]) || 0,
				width: Number(parts[4]) || 0,
				height: Number(parts[5]) || 0,
			});
		}
		return { ok: true, windows };
	}
}

// ============================================================================
// PNG dimensions (no extra deps)
// ============================================================================

function pngDimensions(buf: Buffer): { w: number; h: number } | null {
	// PNG signature: 8 bytes, then IHDR chunk at offset 16 (length 4) + width(4) + height(4)
	if (buf.length < 24) return null;
	const sig = buf.subarray(0, 8);
	if (
		sig[0] !== 0x89 ||
		sig[1] !== 0x50 ||
		sig[2] !== 0x4e ||
		sig[3] !== 0x47 ||
		sig[4] !== 0x0d ||
		sig[5] !== 0x0a ||
		sig[6] !== 0x1a ||
		sig[7] !== 0x0a
	) {
		return null;
	}
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	return { w, h };
}

// ============================================================================
// Public API
// ============================================================================

let _driver: HandsDriver | null = null;

/**
 * Returns the singleton macOS driver. The first call probes for `cliclick` and
 * verifies `screencapture` / `osascript`. Subsequent calls are free.
 */
export function getDriver(): HandsDriver {
	if (!_driver) _driver = new MacosDriver();
	return _driver;
}

/** Test-only: reset the singleton + capability cache. */
export function _resetForTests(): void {
	_driver = null;
	_caps = null;
}

/** Removes a screenshot file the driver wrote. Best-effort. */
export function disposeScreenshot(p: string): void {
	try {
		if (existsSync(p)) unlinkSync(p);
	} catch {
		// best-effort cleanup
	}
}
