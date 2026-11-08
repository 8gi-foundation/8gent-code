/**
 * #4720 harness: the /provider picker on a narrow terminal. Selecting a provider
 * must close the picker, and with no model pinned the model list opens once.
 */
import { bootApp, strip, tick, waitFor } from "./app-driver.js";

async function main() {
	const cols = Number(process.env.HARNESS_COLS ?? 52);
	const app = await bootApp(cols, Number(process.env.HARNESS_ROWS ?? 34), {
		provider: "ollama",
		model: "none",
	});
	const m = await app.submit("/provider");
	await waitFor(() => app.since(m).includes("Select Provider"), "picker opens", 15000);
	const opened = app.since(m);
	// Filter to the one row, then Enter.
	const f = app.mark();
	// The picker draws a frame before its key handler is attached, and keys sent in
	// that gap are dropped. Send the first key until it is drawn, then the rest.
	const firstKeyDeadline = performance.now() + 15000;
	while (!app.since(f).includes("Search: m")) {
		if (performance.now() > firstKeyDeadline) break;
		app.feed("m");
		await tick(500);
	}
	app.feed("inimax");
	// Enter only once the picker has drawn the filter. On a starved runner a fixed
	// pause let Enter land on the unfiltered row the picker opened on, and the
	// switch line named another provider.
	await waitFor(() => app.since(f).includes("Search: minimax"), "filter drawn", 15000);
	const sel = app.mark();
	app.feed("\r");
	await waitFor(
		() => app.since(sel).includes("Provider switched to: MiniMax"),
		"switch line",
		15000,
	);
	await tick(3000);
	// The last full frame is what a person is looking at now.
	const tail = app.since(sel);
	const lastPicker = tail.lastIndexOf("Select Provider");
	const lastLine = tail.lastIndexOf("Provider switched to: MiniMax");
	app.emit({
		phase: "picker",
		cols,
		opened: opened.includes("Select Provider"),
		firstRowsMiniMaxBeforeOllamaDown: (() => {
			const list = opened.slice(Math.max(0, opened.indexOf("Select Provider")));
			const a = list.indexOf("MiniMax");
			const b = list.indexOf("Ollama");
			return { minimax: a, ollama: b };
		})(),
		activeNotReachable: opened.includes("active, not reachable"),
		stillOpen: lastPicker > lastLine,
		filterLeakedAsMessage: /You\s*\n[^\n]*minimax/.test(tail),
		modelListOpened:
			tail.includes(process.env.SWITCH_MODEL ?? "") && /Select Model|Models?/i.test(tail),
	});
	process.exit(0);
}
main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
