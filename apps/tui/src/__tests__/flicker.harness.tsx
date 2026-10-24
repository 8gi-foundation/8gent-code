/**
 * Harness for flicker.test.ts (#4970). Boots the real App on a fake TTY of
 * FLICKER_COLS x FLICKER_ROWS, sends one prompt to the streaming fake model
 * and records every stdout write until the turn ends.
 * Emits the counts the test bounds: full-screen clears, frames (synchronized
 * output blocks), bytes, and the window length, from Enter to the status
 * card's DONE.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";
import { replay } from "./vt-screen.js";

const COLS = Number(process.env.FLICKER_COLS ?? 52);
const ROWS = Number(process.env.FLICKER_ROWS ?? 30);

// Erase display (2J), erase scrollback (3J). Ink's clearTerminal is 2J 3J H.
// biome-ignore lint/suspicious/noControlCharactersInRegex: counting escapes
const CLEAR = /\u001B\[[23]J/g;
const FRAME = "\u001B[?2026h";
// Erase-in-line. Ink's eraseLines blanks every row of the last frame this way
// before it writes the next one, so this counts rows blanked.
// biome-ignore lint/suspicious/noControlCharactersInRegex: counting escapes
const ERASE_LINE = /\u001B\[2K/g;

async function main() {
	const app = await bootApp(COLS, ROWS, { provider: "ollama", model: "shell-test:1b" }, true);
	await tick(500);
	const m = await app.submit("list the files then explain them");
	const start = Date.now();
	// FLICKER_KEYBOARD: the phone keyboard opens and closes mid-turn. Termux
	// shrinks the rows to about half and back, a resize each way.
	if (process.env.FLICKER_KEYBOARD) {
		await tick(1500);
		app.resize(COLS, Math.floor(ROWS / 2));
		await tick(1500);
		app.resize(COLS, ROWS);
	}
	try {
		// The status card says DONE when the turn ends. At 52x14 the reply can sit
		// above the visible rows, so the last word is not always on screen.
		await waitFor(() => app.since(m).includes("● DONE"), "turn done", 45000);
	} catch (e) {
		app.emit({ phase: "screen", tail: app.since(m).slice(-3000) });
		throw e;
	}
	const end = Date.now();
	await tick(300);
	const writes = app.writesSince(start).filter((w) => w.at <= end);
	let clears = 0;
	let frames = 0;
	let bytes = 0;
	let erasedRows = 0;
	for (const w of writes) {
		clears += w.text.match(CLEAR)?.length ?? 0;
		frames += w.text.split(FRAME).length - 1;
		bytes += Buffer.byteLength(w.text);
		erasedRows += w.text.match(ERASE_LINE)?.length ?? 0;
	}
	const seconds = (end - start) / 1000;
	app.emit({
		phase: "turn",
		cols: COLS,
		rows: ROWS,
		seconds,
		writes: writes.length,
		clears,
		frames,
		bytes,
		clearsPerSec: clears / seconds,
		framesPerSec: frames / seconds,
		bytesPerSec: bytes / seconds,
		erasedRows,
		erasedRowsPerSec: erasedRows / seconds,
	});
	// What the terminal shows once the turn has settled, replayed from every
	// byte written since boot, so a writer that skips rows can be checked.
	await tick(1200);
	app.emit({ phase: "screen-final", rows: replay(app.raw(), COLS, ROWS) });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
