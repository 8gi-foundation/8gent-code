/**
 * Harness for bang.test.tsx (#3918 D5). In the real App:
 * - `!!cmd` shows output only; `!cmd` shows it and sends it with the next
 *   message, once (the test reads what the fake model was sent);
 * - a slow `!cmd` shows a running line, and Esc stops it;
 * - Plan mode refuses shell lines;
 * - after /quit, no file under HOME holds `!!` output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";
const BUN = JSON.stringify(process.execPath);
// The output joins two halves, so the command text never contains it.
const LOCAL = `!!${BUN} -e "console.log('kept' + '-local-xyz')"`;

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...filesUnder(p));
		else if (e.isFile()) out.push(p);
	}
	return out;
}

async function main() {
	const app = await bootApp(160, 60);
	let m = await app.submit(LOCAL);
	await waitFor(() => app.since(m).includes("Not sent to 8gent."), "!! result");
	app.emit({ phase: "local", ok: app.since(m).includes("kept-local-xyz") });

	// A credentials file: it runs and shows, but is never sent.
	m = await app.submit("!echo credfile-zz9 # .env");
	await waitFor(
		() => app.since(m).includes("Not sent to 8gent: it reads a credentials file."),
		"credentials refusal",
	);
	app.emit({ phase: "cred", shown: app.since(m).includes("credfile-zz9") });

	m = await app.submit("!echo from-the-shell-abc");
	await waitFor(() => app.since(m).includes("Goes to 8gent with your next message."), "! result");
	app.emit({ phase: "send", ok: app.since(m).includes("from-the-shell-abc") });

	m = await app.submit("what did it print");
	await waitFor(() => app.since(m).includes(REPLY), "first reply", 30000);
	await tick(800);
	m = await app.submit("and now");
	await waitFor(() => app.since(m).includes(REPLY), "second reply", 30000);
	await tick(500);

	// A slow command shows a running line; Esc stops it.
	m = await app.submit(`!${BUN} -e "setTimeout(() => {}, 20000)"`);
	await waitFor(() => app.since(m).includes("(running, Esc to stop)"), "running line");
	await tick(300);
	const started = Date.now();
	m = app.mark();
	app.feed("\x1b");
	await waitFor(() => app.since(m).includes("(stopped) Not sent to 8gent."), "stopped line", 5000);
	app.emit({ phase: "cancel", ms: Date.now() - started });
	await tick(300);

	// Plan mode: Shift+Tab from Ask goes Guarded, Infinite, Plan.
	for (let i = 0; i < 3; i++) {
		app.feed("\x1b[Z");
		await tick(250);
	}
	m = await app.submit("!echo should-not-run-123");
	await waitFor(() => app.since(m).includes("Plan mode runs nothing"), "plan refusal");
	app.emit({ phase: "plan", ran: app.since(m).includes("$ echo should-not-run-123\nshould") });
	app.feed("\x1b[Z"); // back to Ask
	await tick(300);

	await app.submit("/quit");
	await waitFor(() => app.exited(), "exit after /quit");
	await tick(300);
	const home = process.env.HOME ?? "";
	const leaks = filesUnder(home).filter((f) => {
		try {
			return fs.readFileSync(f, "utf8").includes("kept-local-xyz");
		} catch {
			return false;
		}
	});
	const sessions = filesUnder(home).filter((f) => f.includes("session"));
	app.emit({
		phase: "saved",
		leaks: leaks.map((f) => path.relative(home, f)),
		sessions: sessions.length,
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
