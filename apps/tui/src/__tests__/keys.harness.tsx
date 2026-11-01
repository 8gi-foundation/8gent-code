/**
 * Harness for keys.test.tsx: in the real App, Ctrl+L opens the model picker
 * and Enter switches the model, and /hotkeys prints the key table (#3918 D3, D8, B4).
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

async function main() {
	const app = await bootApp(160, 80);
	let m = app.mark();
	app.feed("\x0c"); // Ctrl+L
	await waitFor(() => app.since(m).includes("Select Model"), "model picker after Ctrl+L");
	await tick(300);
	m = app.mark();
	app.feed("\r");
	await waitFor(() => app.since(m).includes("Model switched to:"), "model switched");
	app.emit({ phase: "ctrl-l", ok: true, line: app.since(m).match(/Model switched to: \S+/)?.[0] });
	await tick(300);

	// /model with no name opens the same picker; Esc closes it and gives the
	// input back.
	m = await app.submit("/model");
	await waitFor(() => app.since(m).includes("Select Model"), "model picker after /model");
	await tick(300);
	m = app.mark();
	app.feed("\x1b");
	await waitFor(() => app.since(m).includes("Type a command"), "input back after Esc");
	app.emit({ phase: "slash-model", ok: true });
	await tick(300);

	m = await app.submit("/hotkeys");
	await waitFor(() => app.since(m).includes("Keyboard shortcuts:"), "/hotkeys output");
	await tick(300);
	app.emit({ phase: "hotkeys", screen: app.since(m) });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
