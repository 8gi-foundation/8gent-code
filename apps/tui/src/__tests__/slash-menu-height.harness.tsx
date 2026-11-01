/**
 * Harness for slash-menu-height.test.tsx: a bare `/` in the real App at the
 * terminal height in SHELL_ROWS. Prints the last frame with the menu open,
 * then presses Down to the end and Up back to the top, printing which row is
 * picked after each press (#3918 D9, 8PO).
 */
import { bootApp, strip, tick } from "./app-driver.js";

const ROWS = Number(process.env.SHELL_ROWS ?? 24);

/** Poll `get` until it returns a value `ok` accepts; throw with the last frame if it never does. */
async function settle<T>(
	get: () => T,
	ok: (v: T) => boolean,
	label: string,
	dump: () => string,
	ms = 10_000,
) {
	const start = Date.now();
	for (;;) {
		const v = get();
		if (ok(v)) return v;
		if (Date.now() - start > ms)
			throw new Error(`timed out waiting for ${label}; last frame:\n${dump()}`);
		await tick(25);
	}
}

async function main() {
	const app = await bootApp(120, ROWS);
	// The last complete frame: from the last header to the footer after it.
	// Null while Ink is still writing it (a slow runner can be read mid-frame).
	const complete = (): string | null => {
		const s = strip(app.raw());
		const head = s.lastIndexOf("8gent Code v");
		// The footer row starts with the mode. Its right end varies (on CI a
		// "providers 1/3" field pushes "[^C] quit" past 120 columns), so the
		// row is matched by its start and taken whole.
		const foot = s.indexOf("\nmode ", head);
		if (head < 0 || foot < 0) return null;
		const end = s.indexOf("\n", foot + 1);
		return end < 0 ? null : s.slice(head, end);
	};
	const dump = () => strip(app.raw()).slice(-3000);
	const picked = (f: string | null) =>
		f
			?.match(/> \/([a-z-]+)/g)
			?.at(-1)
			?.slice(3) ?? "";
	// The frame once the menu has drawn with its position line, footer included.
	const menuFrame = () =>
		settle(
			complete,
			(f) => f !== null && /> \/[a-z]/.test(f) && / of 14, Up\/Down/.test(f),
			"menu frame",
			dump,
		);

	app.feed("/");
	const open = (await menuFrame()) as string;
	app.emit({ phase: "open", frame: open, picked: picked(open) });

	// Down until the last row is picked, waiting on each render.
	const seen = [picked(open)];
	while (seen.at(-1) !== "skills" && seen.length < 20) {
		const before = seen.at(-1);
		app.feed("\x1b[B");
		const f = await settle(
			complete,
			(v) => picked(v) !== "" && picked(v) !== before,
			`row after ${before}`,
			dump,
		);
		seen.push(picked(f));
	}
	const last = seen.at(-1);
	// Up until the first row is picked again.
	let top = last ?? "";
	for (let i = 0; i < 20 && top !== "clear"; i++) {
		const before = top;
		app.feed("\x1b[A");
		top = picked(
			await settle(
				complete,
				(v) => picked(v) !== "" && picked(v) !== before,
				`row before ${before}`,
				dump,
			),
		);
	}
	app.emit({ phase: "scroll", seen, last, top });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
