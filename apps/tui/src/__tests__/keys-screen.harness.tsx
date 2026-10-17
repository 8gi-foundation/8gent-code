/**
 * Harness for the screen half of keybindings.test.ts: press every Ctrl key
 * /hotkeys teaches, in the real App, and report whether the screen changed,
 * then undo it (#3918 D8). A key that changes nothing does not belong in
 * the table.
 */
import { bootApp, strip, tick } from "./app-driver.js";

interface Probe {
	key: string;
	bytes: string;
	undo?: string;
}

// Order matters: Ctrl+W closes the tab Ctrl+T opened.
export const PROBES: Probe[] = [
	{ key: "Ctrl+L", bytes: "\x0c", undo: "\x1b" },
	{ key: "Ctrl+P", bytes: "\x10", undo: "\x10" },
	{ key: "Ctrl+X", bytes: "\x18", undo: "\x18" },
	{ key: "Ctrl+Y", bytes: "\x19" },
	// Cycles Act, Think, Quiet: the footer word changes. Three presses return to Act.
	{ key: "Ctrl+Q", bytes: "\x11", undo: "\x11\x11" },
	{ key: "Ctrl+A", bytes: "\x01", undo: "\x01" },
	{ key: "Ctrl+S", bytes: "\x13", undo: "\x13" },
	{ key: "Ctrl+G", bytes: "\x07" },
	{ key: "Ctrl+F", bytes: "\x06" },
	{ key: "Ctrl+T", bytes: "\x14" },
	{ key: "Ctrl+W", bytes: "\x17" },
];

async function main() {
	const app = await bootApp(160, 50);
	// The last frame, without what changes on its own (clock, spinners).
	const frame = () => {
		const s = strip(app.raw());
		return s.slice(s.lastIndexOf("8gent Code v")).replace(/[\d⠀-⣿]/g, "");
	};
	for (const p of PROBES) {
		await tick(700);
		const before = frame();
		app.feed(p.bytes);
		await tick(700);
		app.emit({ phase: "probe", key: p.key, changed: frame() !== before });
		if (p.undo) app.feed(p.undo);
	}
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
