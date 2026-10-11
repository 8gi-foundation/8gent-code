/**
 * Harness for copy.test.tsx: ask the fake model something, then /copy, and
 * print the raw bytes the App wrote after it (#3918 D7).
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";

async function main() {
	const app = await bootApp(160, 60);
	let m = await app.submit("/copy");
	await waitFor(() => app.since(m).includes("Nothing to copy yet"), "/copy with no answer");
	app.emit({ phase: "empty", ok: true });

	m = await app.submit("say the magic words");
	await waitFor(() => app.since(m).includes(REPLY), "model reply", 30000);
	await tick(500);

	const rawFrom = app.raw().length;
	m = await app.submit("/copy");
	await waitFor(() => app.since(m).includes("Copied the last answer"), "/copy reply");
	app.emit({
		phase: "copied",
		line: app.since(m).match(/Copied the last answer \(\d+ characters?\)\./)?.[0],
		raw: app.raw().slice(rawFrom),
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
