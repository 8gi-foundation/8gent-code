/**
 * Harness for theme-user-app.test.tsx: a user theme file in the child's home
 * shows up in the real App's /theme picker (Pi parity N1). When
 * THEME_CAST is set, the rendered frames are also written there as an
 * asciicast v2 file (fake-TTY capture, not a pty).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../../../../packages/core/home.js";
import { bootApp, tick, waitFor } from "./app-driver.js";

async function main() {
	const dir = path.join(resolveHome(), ".8gent", "themes");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "ember.json"),
		JSON.stringify({ base: "dark", label: "Ember Night", description: "My warm theme", orange: "#FF8800", bg: "#140C06" }),
	);
	fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ base: "dark", orang: "#FFF" }));

	const castPath = process.env.THEME_CAST;
	const frames: [number, string][] = [];
	const t0 = Date.now();
	const record = (s: string) => frames.push([(Date.now() - t0) / 1000, `${s.replace(/\n/g, "\r\n")}\r\n`]);

	const app = await bootApp(120, 40);
	let m = app.mark();
	await app.submit("/theme");
	await waitFor(() => app.since(m).includes("Theme ("), "theme picker");
	await tick(300);
	record(app.since(m).slice(app.since(m).lastIndexOf("Theme (")));
	// maxVisible is 10: arrow down to the end of the list, where user themes sit.
	for (let i = 0; i < 80 && !app.since(m).includes("Ember Night"); i++) {
		const before = app.mark();
		app.feed("\x1b[B");
		await tick(40);
		if (app.since(before).includes("Ember Night")) break;
	}
	await waitFor(() => app.since(m).includes("Ember Night"), "user theme in picker");
	await tick(400);
	const screen = app.since(m);
	record(screen.slice(screen.lastIndexOf("Theme (")));
	app.emit({
		phase: "picker",
		listed: screen.includes("Ember Night"),
		description: screen.includes("My warm theme"),
		brokenListed: screen.includes("broken"),
	});
	// Select it: the cursor is on the last row once the list stopped scrolling.
	m = app.mark();
	app.feed("\r");
	await waitFor(() => /Theme set to|Could not save/.test(app.since(m)), "picker result");
	await tick(300);
	const picked = app.since(m);
	const cfgFile = path.join(resolveHome(), ".8gent", "config.json");
	const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
	app.emit({ phase: "picked", applied: picked.includes("Theme set to Ember Night"), error: picked.includes("Could not save"), userTheme: cfg.userTheme ?? null, designSystem: cfg.designSystem ?? null });

	// The text path, then /reload.
	m = app.mark();
	await app.submit("/theme default");
	await waitFor(() => app.since(m).includes("Theme set to 8gent"), "default");
	m = app.mark();
	await app.submit("/theme user:ember");
	await waitFor(() => /Theme set to|Could not|Unknown/.test(app.since(m)), "text path result");
	await tick(300);
	const text = app.since(m);
	const cfg2 = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
	app.emit({ phase: "text", applied: text.includes("Theme set to Ember Night"), userTheme: cfg2.userTheme ?? null });

	m = app.mark();
	await app.submit("/reload");
	await waitFor(() => app.since(m).includes("Reloaded themes"), "reload");
	await tick(200);
	app.emit({ phase: "reload", mentionsBroken: app.since(m).includes("broken.json") });
	if (castPath) {
		const header = { version: 2, width: 120, height: 40, timestamp: Math.floor(t0 / 1000), title: "8gent /theme picker with a user theme (fake TTY capture)" };
		fs.writeFileSync(castPath, [JSON.stringify(header), ...frames.map(([t, f]) => JSON.stringify([t, "o", f]))].join("\n") + "\n");
	}
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
