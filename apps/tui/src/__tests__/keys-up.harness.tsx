/**
 * Harness for keys-up.test.tsx (#4967): boot the real App at the size in
 * KEYS_UP_COLS x KEYS_UP_ROWS, ask the fake model one question, and print the
 * screen as the last frame Ink drew it, before and after the answer.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const COLS = Number(process.env.KEYS_UP_COLS ?? 52);
const ROWS = Number(process.env.KEYS_UP_ROWS ?? 14);
const REPLY = process.env.FAKE_REPLY ?? "";
const FIRST_WORD = REPLY.split(/\s+/)[0] ?? "";

async function main() {
	const app = await bootApp(COLS, ROWS);
	app.emit({ phase: "idle", rows: app.frame() });

	const m = await app.submit("what is this repo");
	await waitFor(() => app.since(m).includes(FIRST_WORD), "model reply", 30000).catch((e) => {
		app.emit({ phase: "timeout", rows: app.frame() });
		throw e;
	});
	await tick(1200);
	app.emit({ phase: "reply", rows: app.frame() });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
