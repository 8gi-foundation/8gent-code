/**
 * Minimal Ink render harness for bun:test.
 *
 * Ink only needs a stdin that looks like a raw-mode TTY (isTTY, setRawMode,
 * a `readable` event plus `read()`) and a stdout with `columns` / `rows`
 * and `write`. With `debug: true` Ink writes every frame in full, with no
 * cursor-movement escapes, so the last write IS the screen.
 */

import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type React from "react";

class FakeStdin extends EventEmitter {
	isTTY = true;
	private chunks: string[] = [];
	setRawMode(): void {}
	setEncoding(): void {}
	ref(): void {}
	unref(): void {}
	resume(): void {}
	pause(): void {}
	read(): string | null {
		return this.chunks.shift() ?? null;
	}
	/** Feed raw bytes as if the user typed them. */
	type(data: string): void {
		this.chunks.push(data);
		this.emit("readable");
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true;
	columns: number;
	rows: number;
	frames: string[] = [];
	constructor(columns: number, rows: number) {
		super();
		this.columns = columns;
		this.rows = rows;
	}
	write(chunk: string): boolean {
		this.frames.push(chunk);
		return true;
	}
	get lastFrame(): string {
		return this.frames.at(-1) ?? "";
	}
}

export interface Harness {
	stdin: FakeStdin;
	stdout: FakeStdout;
	/** Last full frame, ANSI stripped. */
	frame: () => string;
	/** Type raw bytes, then let Ink's input flush and React commit. */
	type: (data: string) => Promise<void>;
	/** Settle pending renders without typing. */
	settle: () => Promise<void>;
	unmount: () => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function renderInk(
	tree: React.ReactElement,
	size: { columns: number; rows: number } = { columns: 100, rows: 30 },
): Harness {
	const stdin = new FakeStdin();
	const stdout = new FakeStdout(size.columns, size.rows);
	const instance = inkRender(tree, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
	return {
		stdin,
		stdout,
		frame: () => stdout.lastFrame.replace(ANSI, ""),
		type: async (data) => {
			stdin.type(data);
			await settle();
		},
		settle,
		unmount: () => instance.unmount(),
	};
}

/** Control-key byte for a letter, e.g. ctrl("u") === "\x15". */
export function ctrl(letter: string): string {
	return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
}
