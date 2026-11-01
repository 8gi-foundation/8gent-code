/**
 * Harness for core-menu.test.tsx: in the real App, a bare `/` shows the core
 * commands only, a typed prefix still reaches the rest, and /help shows core
 * commands with /help all for everything (#3918 D9).
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

async function main() {
	// Tall enough that the whole /help reply is on screen.
	const app = await bootApp(160, 120);
	let m = app.mark();
	app.feed("/");
	await waitFor(() => app.since(m).includes("COMMANDS"), "slash menu");
	await tick(300);
	const bare = app.since(m);
	app.emit({ phase: "bare", screen: bare.slice(bare.lastIndexOf("COMMANDS")) });

	m = app.mark();
	app.feed("dj");
	await waitFor(() => app.since(m).includes("/dj"), "typed prefix reaches /dj");
	await tick(200);
	app.emit({ phase: "prefix", ok: true });
	for (let i = 0; i < 3; i++) {
		app.feed("\x7f");
		await tick(60);
	}
	await tick(200);

	m = await app.submit("/help");
	await waitFor(() => app.since(m).includes("Core commands"), "/help output");
	await tick(200);
	app.emit({ phase: "help", screen: app.since(m) });

	m = await app.submit("/help all");
	await waitFor(() => app.since(m).includes("expands to its prompt"), "/help all output");
	app.emit({ phase: "help-all", ok: true });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
