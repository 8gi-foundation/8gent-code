/**
 * Harness for slash-menu-height.test.tsx: a bare `/` in the real App at the
 * terminal height in SHELL_ROWS. Prints the last frame with the menu open,
 * then presses Down to the end and Up back to the top, printing which row is
 * picked after each press (#3918 D9, 8PO).
 */
import { bootApp, strip, tick, waitFor } from "./app-driver.js";

const ROWS = Number(process.env.SHELL_ROWS ?? 24);

async function main() {
	const app = await bootApp(120, ROWS);
	// The last full frame: from the last header to the footer after it.
	const frame = () => {
		const s = strip(app.raw());
		const head = s.lastIndexOf("8gent Code v");
		const foot = s.indexOf("[^C] quit", head);
		return s.slice(head, foot >= 0 ? foot + 9 : undefined);
	};
	const picked = () =>
		frame()
			.match(/> \/([a-z-]+)/g)
			?.at(-1)
			?.slice(3) ?? "";
	const m = app.mark();
	app.feed("/");
	await waitFor(() => app.since(m).includes("> /clear"), "menu");
	await tick(400);
	app.emit({ phase: "open", frame: frame(), picked: picked() });
	const seen = new Set<string>([picked()]);
	for (let i = 0; i < 20; i++) {
		app.feed("\x1b[B");
		await tick(120);
		seen.add(picked());
	}
	const last = picked();
	for (let i = 0; i < 20; i++) {
		app.feed("\x1b[A");
		await tick(120);
	}
	app.emit({ phase: "scroll", seen: [...seen], last, top: picked() });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
