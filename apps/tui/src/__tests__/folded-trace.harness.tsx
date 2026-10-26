/**
 * Harness for folded-trace.test.tsx (#5170). In the real App, against a scripted
 * model that makes six read calls one after another:
 * - the running turn shows one "Working:" row, not a row per call;
 * - Enter (empty input) opens the step list in place, rendered as before;
 * - Enter again folds it; Esc folds an open list without stopping the turn;
 * - the footer names the key while the row is up;
 * - the turn then finishes into its answer.
 * With EIGHT_TUI_TRACE=on the per-call rows show and there is no status row.
 * FOLD_COLS sets the terminal width. Emits JSON lines.
 */
import { bootApp, finish, tick, waitFor } from "./app-driver.js";

let screen: (() => string) | null = null;

const COLS = Number(process.env.FOLD_COLS ?? 100);
const TRACE_ON = process.env.EIGHT_TUI_TRACE === "on";
/** The status row: "Working: ..." wide, "Enter: steps ..." or "Esc closes ..." under 60 columns. */
const isRow = (s: string) => /Working:|Enter: steps|Esc closes/.test(s);

async function main() {
	const app = await bootApp(COLS, 44);
	screen = () => app.frame().join("\n");
	const text = () => app.frame().join("\n");
	const callRows = () => app.frame().filter((l) => /read_file/.test(l)).length;

	const m = await app.submit("read the six colour files");
	if (TRACE_ON) {
		await waitFor(() => callRows() >= 2, "per-call rows with the setting on");
		const live = text();
		app.emit({
			phase: "setting-on",
			callRows: callRows(),
			hasStatusRow: isRow(live),
			footerHint: /Enter (shows|folds) steps/.test(live),
		});
	} else {
		await waitFor(() => isRow(text()), "status row");
		await tick(400);
		const folded = text();
		app.emit({
			phase: "folded",
			statusRows: app.frame().filter((l) => isRow(l)).length,
			callRows: callRows(),
			footerHint: /Enter shows steps/.test(folded),
			frame: folded,
		});

		// Enter opens the list in place, with today's rows.
		app.feed("\r");
		await waitFor(() => text().includes("▾") || text().includes("v Working"), "open marker");
		await tick(400);
		const open = text();
		app.emit({
			phase: "open",
			callRows: callRows(),
			footerHint: /Enter folds steps/.test(open),
			frame: open,
		});

		// Enter again folds it.
		app.feed("\r");
		await waitFor(() => callRows() === 0, "folded again by Enter");
		app.emit({ phase: "refolded", ok: true });

		// Esc folds an open list, and the turn keeps running.
		app.feed("\r");
		await waitFor(() => callRows() > 0, "open again");
		app.feed("\x1b");
		await waitFor(() => callRows() === 0, "folded by Esc");
		await tick(300);
		app.emit({
			phase: "esc-folds",
			stillRunning: !text().includes("Generation interrupted"),
		});
	}

	await waitFor(() => text().includes("ALL_SIX_DONE"), "the answer", 40000);
	await tick(500);
	const done = text();
	app.emit({
		phase: "finished",
		hasStatusRow: isRow(done),
		hasAnswer: done.includes("ALL_SIX_DONE"),
		frame: done,
	});
	void m;
	await finish(0);
}

main().catch((e) => {
	process.stdout.write(
		`\n${JSON.stringify({ phase: "error", message: String(e?.message ?? e), screen: screen?.() })}\n`,
	);
	return finish(1);
});
