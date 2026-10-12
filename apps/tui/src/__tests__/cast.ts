/**
 * Frame capture for fake-TTY runs (#3918). The sandbox has no pty, so a
 * harness records the screen as it goes: `frame()` is the last full draw
 * (everything after the header's last redraw, ANSI stripped). The test
 * writes the frames as an asciicast v2 file a person can play with
 * `asciinema play <file>`; it is a capture of the real App's output on a
 * fake TTY, not a terminal recording.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DrivenApp } from "./app-driver.js";
import { strip } from "./app-driver.js";

export interface Frame {
	/** Seconds since the recording started. */
	t: number;
	/** What the harness was doing when it took the frame. */
	label: string;
	text: string;
}

export function frameOf(app: DrivenApp): string {
	const s = strip(app.raw());
	const at = s.lastIndexOf("8gent Code v");
	return at === -1 ? s.slice(-6000) : s.slice(at);
}

export function recorder(app: DrivenApp) {
	const started = Date.now();
	const frames: Frame[] = [];
	return {
		frames,
		take(label: string) {
			frames.push({ t: (Date.now() - started) / 1000, label, text: frameOf(app) });
		},
	};
}

/**
 * The cast file path for a row: $EIGHT_CAST_DIR/<name>.cast, else
 * $TMPDIR/8gent-casts/<name>.cast (the test run's TMPDIR, removed with it).
 */
export function castPath(name: string): string {
	const dir = process.env.EIGHT_CAST_DIR || path.join(process.env.TMPDIR || "/tmp", "8gent-casts");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${name}.cast`);
}

export function writeCast(
	file: string,
	frames: readonly Frame[],
	cols: number,
	rows: number,
	title: string,
) {
	const header = {
		version: 2,
		width: cols,
		height: rows,
		timestamp: Math.floor(Date.now() / 1000),
		title,
		env: { TERM: "fake-tty", SHELL: "none" },
	};
	const lines = [JSON.stringify(header)];
	for (const f of frames) {
		// Each frame clears the screen and draws the capture, with its label on top.
		const body = `\u001b[2J\u001b[H[${f.label}]\r\n${f.text.replace(/\n/g, "\r\n")}`;
		lines.push(JSON.stringify([Number(f.t.toFixed(3)), "o", body]));
	}
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}
