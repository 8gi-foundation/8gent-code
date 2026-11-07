/**
 * Harness for every-slash.test.tsx. In the real App: a typo is answered, then
 * each registered built-in slash command is submitted bare and must put
 * something on screen (or, for the exit commands, end the app). One event per
 * command.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBuiltInSlashCommands } from "../lib/slash-registry.js";
import { bootApp, finish, tick } from "./app-driver.js";

// These end the session, so they run last.
const EXITS = new Set(["quit", "exit"]);
// Commands that wait on the network; they get a longer window.
const SLOW = new Set(["update", "login", "doctor"]);

async function main() {
	process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "every-slash-proj-")));
	const app = await bootApp(160, 60);

	const t = await app.submit("/quite");
	let typoOk = false;
	const t0 = Date.now();
	while (Date.now() - t0 < 5000 && !typoOk) {
		typoOk = app.since(t).includes("Unknown command /quite. Did you mean /quit?");
		await tick(50);
	}
	app.emit({ phase: "typo", ok: typoOk });

	const only = (process.env.EVERY_SLASH_ONLY ?? "").split(",").filter(Boolean);
	const slowMs = Number(process.env.EVERY_SLASH_WAIT_MS ?? 4000);
	const names = getBuiltInSlashCommands()
		.map((c) => c.name as string)
		.filter((n) => only.length === 0 || only.includes(n));
	const ordered = [...names.filter((n) => !EXITS.has(n)), ...names.filter((n) => EXITS.has(n))];
	for (const name of ordered) {
		let m: number;
		const notes = () =>
			[...app.since(0).replace(/\s+/g, " ").matchAll(/─── ([^─\n]{4,}?) ───/g)].map((x) => x[1]);
		const seenNotes = new Set(notes());
		const chatCol = (l: string) => (l.split("│")[1] ?? "").replace(/\s+/g, " ").trim();
		const before = new Set(app.frame().map(chatCol));
		const norm = (l: string) => l.replace(/\s+/g, " ").trim();
		const beforeAll = new Set(app.frame().map(norm));
		try {
			m = await app.submit(`/${name}`);
		} catch {
			// The previous command left the input unreachable: clear it and try once more.
			for (let i = 0; i < 3; i++) {
				app.feed("\u001B");
				await tick(200);
			}
			app.feed("\u0015");
			await tick(300);
			try {
				m = await app.submit(`/${name}`);
			} catch {
				app.emit({ phase: "cmd", name, ok: false, sample: "input unreachable after earlier command" });
				continue;
			}
		}
		const typed = `/${name}`;
		const limit = SLOW.has(name) ? 12000 : slowMs;
		const start = Date.now();
		let visible = false;
		let sample = "";
		while (Date.now() - start < limit) {
			if (app.exited()) {
				visible = EXITS.has(name);
				sample = "app exited";
				break;
			}
			// A row on screen that was not there before, other than the typed line and the input hint.
			const fresh = app
				.frame()
				.map(chatCol)
				.filter(
					(l) =>
						l.length > 3 &&
						!before.has(l) &&
						!l.includes(typed) &&
						!/Ask, or type|Type a command/.test(l) &&
						/[A-Za-z0-9]{3}/.test(l),
				);
			// System messages are written to the scrollback ("--- text ---"), not the live frame.
			const note = notes().find((n) => !seenNotes.has(n));
			if (note) {
				visible = true;
				sample = note.slice(0, 120);
				break;
			}
			// A whole-screen change (a view or picker opened): many rows that were not there before.
			const changed = app.frame().map(norm).filter((l) => l && !beforeAll.has(l));
			if (changed.length >= 6) {
				visible = true;
				sample = `screen changed (${changed.length} new rows): ${changed[0].slice(0, 80)}`;
				break;
			}
			if (fresh.length > 0) {
				visible = true;
				sample = fresh[0].slice(0, 120);
				break;
			}
			await tick(50);
		}
		if (!visible && process.env.EVERY_SLASH_DEBUG) {
			sample = app.since(m).replace(/\s+/g, " ").slice(-700);
		}
		app.emit({ phase: "cmd", name, ok: visible, sample });
		if (app.exited()) break;
		// Close any overlay the command opened before the next one.
		app.feed("\u001B");
		await tick(150);
		app.feed("\u001B");
		// Let a slow answer land before the next command, so it is not credited to that one.
		await tick(900);
	}
	await finish(0);
}

main().catch(async (e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	await finish(1);
});
