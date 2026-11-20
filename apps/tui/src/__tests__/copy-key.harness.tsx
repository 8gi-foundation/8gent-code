/**
 * Harness for copy-key.test.tsx: press Ctrl+U before and after a model reply
 * and report the footer line and the raw bytes written (#181).
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";
const FIRST = process.env.FAKE_FIRST ?? "";

async function main() {
	const app = await bootApp(160, 60);
	let m = app.mark();
	app.feed("\x15");
	await waitFor(() => app.since(m).includes("Nothing to copy yet"), "Ctrl+U with no answer");
	app.emit({ phase: "empty", ok: true });
	await tick(2300);

	m = (await app.submit("say the magic words")) as number;
	await waitFor(() => app.since(m).includes(FIRST), "model reply", 60000);
	await tick(800);

	const rawFrom = app.raw().length;
	m = app.mark();
	app.feed("\x15");
	await waitFor(() => /(Sent|Not copied)/.test(app.since(m)), "Ctrl+U reply", 20000);
	app.emit({
		phase: "copied",
		line: app
			.since(m)
			.match(/(Sent \d+ lines? to the terminal clipboard|Not copied: \d+ lines? is too long)/)?.[0],
		raw: app.raw().slice(rawFrom),
		replyLength: REPLY.length,
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
