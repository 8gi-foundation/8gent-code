/**
 * Harness for provider-key-rejected.test.tsx: the phone case, in the real App.
 * /provider minimax with a key the endpoint refuses (401) and a model list an earlier
 * discovery recorded, then a message. The screen must name the refused key and the
 * command that fixes it, and must not show the bare "all providers failed" count.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

async function main() {
	const app = await bootApp(80, 40);
	const m = await app.submit("/provider minimax");
	await waitFor(() => app.since(m).includes("Provider switched to: MiniMax"), "switch line");
	await waitFor(
		() => app.since(m).includes("rejected its key"),
		"key rejected notice",
		30000,
	).catch(() => {});
	const s = await app.submit("how are the tests doing");
	await tick(4000);
	// The screen wraps at 80 columns: compare with each run of whitespace as one space.
	const flat = (t: string) => t.replace(/[\s\u2502]+/g, " ");
	const all = flat(app.since(m));
	const afterSend = flat(app.since(s));
	app.emit({
		phase: "phone",
		rejected: all.includes("rejected its key (HTTP 401)"),
		command: all.includes("8gent keys set minimax"),
		nothingRun: afterSend.includes("Nothing was run"),
		bareCount: all.includes("all providers failed"),
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
