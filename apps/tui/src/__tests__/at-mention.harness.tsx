/**
 * Harness for at-mention.test.tsx: `@` plus part of a name lists matching
 * files in the real App, Tab inserts the picked one, Down picks the next
 * (#3918 D2). Runs in this repo, so the files are real.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const inserted = (screen: string) =>
	[...screen.matchAll(/@(\S*file-mention(?:\.test)?\.ts) /g)].map((m) => m[1]);

async function main() {
	const app = await bootApp(160, 60);
	let m = app.mark();
	app.feed("read @file-menti");
	await waitFor(() => app.since(m).includes("FILES"), "file list");
	await waitFor(() => /file-mention\.ts/.test(app.since(m)), "file-mention.ts listed");
	await tick(300);
	m = app.mark();
	app.feed("\t");
	await waitFor(() => inserted(app.since(m)).length > 0, "Tab inserts the first match");
	const first = inserted(app.since(m)).at(-1);
	await tick(300);

	m = app.mark();
	app.feed("and @file-menti");
	await waitFor(() => app.since(m).includes("FILES"), "file list again");
	await tick(300);
	app.feed("\x1b[B"); // Down
	await tick(300);
	m = app.mark();
	app.feed("\t");
	await waitFor(() => inserted(app.since(m)).length > 1, "Tab inserts the picked match");
	const second = inserted(app.since(m)).at(-1);
	app.emit({ phase: "inserted", first, second });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
