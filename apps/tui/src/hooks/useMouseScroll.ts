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

		// Intercept stdin BEFORE Ink's input parser sees it. Two paths matter:
		//
		// 1. `emit('data', chunk)` — flowing-mode consumers.
		// 2. `read([size])` — Ink in paused mode pulls bytes here after a
		//    `'readable'` event. See node_modules/ink/build/components/App.js
		//    line ~104 (`while ((chunk = stdin.read()) !== null)`).
		//
		// We patch BOTH. Without the read() patch the wheel bytes leak straight
		// into Ink's input parser and end up typed into the focused field.
		const stdin = process.stdin as NodeJS.ReadStream & {
			emit: (event: string | symbol, ...args: unknown[]) => boolean;
			read: (size?: number) => unknown;
		};
		const origEmit = stdin.emit.bind(stdin);
		const origRead = stdin.read.bind(stdin);

		// Shared filter: dispatch wheel events, return the chunk with all mouse
		// SGR sequences stripped (or null if nothing readable remains).
		const filterChunk = (chunk: unknown): unknown => {
			if (chunk == null) return chunk;
			const wasString = typeof chunk === "string";
			const wasBuffer = Buffer.isBuffer(chunk);
			const s = wasString
				? (chunk as string)
				: wasBuffer
					? (chunk as Buffer).toString("utf8")
					: String(chunk);
			if (!s.includes("\x1b[<")) return chunk;

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

			SGR_MOUSE_RE.lastIndex = 0;
			const cleaned = s.replace(SGR_MOUSE_RE, "");
			if (cleaned.length === 0) return null;
			if (wasString) return cleaned;
			if (wasBuffer) return Buffer.from(cleaned, "utf8");
			return cleaned;
		};

		const patchedEmit = function patchedEmit(event: string | symbol, ...args: unknown[]) {
			if (event !== "data" || args.length === 0) return origEmit(event, ...args);
			const filtered = filterChunk(args[0]);
			if (filtered === null) return true; // swallow
			return origEmit(event, filtered, ...args.slice(1));
		};

		const patchedRead = function patchedRead(size?: number) {
			const chunk = origRead(size);
			return filterChunk(chunk);
		};

		stdin.emit = patchedEmit;
		stdin.read = patchedRead;

		return () => {
			// Identity-guarded restore — protects against nested/re-mounted hooks.
			if (stdin.emit === patchedEmit) stdin.emit = origEmit;
			if (stdin.read === patchedRead) stdin.read = origRead;
			activeSubscribers = Math.max(0, activeSubscribers - 1);
			if (activeSubscribers === 0) {
				writeDisable();
			}
		};
	}, [enabled, step]);
}
