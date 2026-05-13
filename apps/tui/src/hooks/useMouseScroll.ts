/**
 * Mouse wheel scrolling for the chat list.
 *
 * Enables xterm SGR mouse reporting (?1000h ?1006h) on mount and tears it down
 * on unmount + on every abnormal exit path. Without bulletproof teardown the
 * terminal stays in mouse-capture mode after the TUI dies and the user has to
 * `reset` their shell, which is unforgivable.
 *
 * Tradeoffs (acceptable, see CLAUDE.md No-BS Mode decision):
 * - Native drag-to-select needs Option (macOS) / Shift (Linux) while focused.
 * - tmux users need `set -g mouse on` for events to reach us.
 *
 * Wheel encoding (SGR mode):
 *   ESC [ < 64 ; col ; row M   wheel up
 *   ESC [ < 65 ; col ; row M   wheel down
 */

import { useEffect, useRef } from "react";

const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1000l\x1b[?1006l";
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)[Mm]/g;

/** Module-level guard: only one consumer enables/disables the sequence. */
let activeSubscribers = 0;
let teardownInstalled = false;

function writeDisable() {
	try {
		process.stdout.write(DISABLE);
	} catch {
		// stdout already closed during exit; nothing we can do.
	}
}

function installProcessTeardown() {
	if (teardownInstalled) return;
	teardownInstalled = true;
	// Four exit paths — any one of them firing without our cleanup leaves the
	// user's terminal in mouse-capture mode.
	process.once("exit", writeDisable);
	process.once("SIGINT", () => {
		writeDisable();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		writeDisable();
		process.exit(143);
	});
	process.once("uncaughtException", (err) => {
		writeDisable();
		// Re-throw so the default handler still prints + exits 1.
		throw err;
	});
}

export interface MouseScrollHandlers {
	onWheelUp: () => void;
	onWheelDown: () => void;
	/** When false, the hook is a no-op (user toggled off, or unsupported env). */
	enabled?: boolean;
	/** Lines moved per wheel tick. iTerm/Chrome default = 3. */
	step?: number;
}

export function useMouseScroll({
	onWheelUp,
	onWheelDown,
	enabled = true,
	step = 3,
}: MouseScrollHandlers) {
	// Latest handlers without re-binding stdin on every render.
	const upRef = useRef(onWheelUp);
	const downRef = useRef(onWheelDown);
	upRef.current = onWheelUp;
	downRef.current = onWheelDown;

	useEffect(() => {
		if (!enabled) return;
		if (!process.stdout.isTTY) return;

		installProcessTeardown();
		if (activeSubscribers === 0) {
			process.stdout.write(ENABLE);
		}
		activeSubscribers++;

		const onData = (buf: Buffer | string) => {
			const s = typeof buf === "string" ? buf : buf.toString("utf8");
			// Ignore non-mouse input fast.
			if (!s.includes("\x1b[<")) return;
			SGR_MOUSE_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = SGR_MOUSE_RE.exec(s)) !== null) {
				const btn = Number.parseInt(m[1], 10);
				if (btn === 64) {
					for (let i = 0; i < step; i++) upRef.current();
				} else if (btn === 65) {
					for (let i = 0; i < step; i++) downRef.current();
				}
			}
		};

		// Ink already sets stdin to raw mode and resumes it. We just listen.
		process.stdin.on("data", onData);

		return () => {
			process.stdin.off("data", onData);
			activeSubscribers = Math.max(0, activeSubscribers - 1);
			if (activeSubscribers === 0) {
				writeDisable();
			}
		};
	}, [enabled, step]);
}
