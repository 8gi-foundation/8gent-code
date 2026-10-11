/**
 * Harness for bang.test.tsx: `!!cmd` shows output only, `!cmd` shows it and
 * sends it with the next message, once (#3918 D5). The test reads what the
 * fake model was sent.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";

async function main() {
	const app = await bootApp(160, 60);
	let m = await app.submit("!!echo kept-local-xyz");
	await waitFor(() => app.since(m).includes("Not sent to 8gent."), "!! result");
	app.emit({ phase: "local", ok: app.since(m).includes("kept-local-xyz") });

	m = await app.submit("!echo from-the-shell-abc");
	await waitFor(() => app.since(m).includes("Goes to 8gent with your next message."), "! result");
	app.emit({ phase: "send", ok: app.since(m).includes("from-the-shell-abc") });

	m = await app.submit("what did it print");
	await waitFor(() => app.since(m).includes(REPLY), "first reply", 30000);
	await tick(800);
	m = await app.submit("and now");
	await waitFor(() => app.since(m).includes(REPLY), "second reply", 30000);
	await tick(500);
	app.emit({ phase: "done", ok: true });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
