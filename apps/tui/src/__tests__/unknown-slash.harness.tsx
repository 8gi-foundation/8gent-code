/**
 * Harness for unknown-slash.test.tsx (#4530). In the real App: an unknown
 * slash line is answered locally, a known command still runs, plain text
 * still reaches the model.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";

async function main() {
	const app = await bootApp(160, 60);
	let m = await app.submit("/nope-xyz-unknown do the thing");
	await waitFor(
		() => app.since(m).includes("Unknown command /nope-xyz-unknown. Type /help."),
		"unknown answer",
	);
	app.emit({ phase: "unknown", ok: true });
	await tick(800);

	m = await app.submit("/help");
	await waitFor(() => !app.since(m).includes("Unknown command /help"), "help not unknown");
	await tick(500);
	app.emit({ phase: "known", ok: !app.since(m).includes("Unknown command /help") });

	m = await app.submit("plain text turn");
	await waitFor(() => app.since(m).includes(REPLY), "plain reply", 30000);
	app.emit({ phase: "plain", ok: true });

	await app.submit("/quit");
	await waitFor(() => app.exited(), "exit after /quit");
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
