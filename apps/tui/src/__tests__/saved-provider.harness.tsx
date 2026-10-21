/**
 * #4720 harness: a second launch. providers.json already holds a hosted choice
 * (as the picker or the one-choice rule saved it), the local default (the fake
 * Ollama the driver serves) is up, and a plain launch must still start on the
 * saved provider and model, not on the local default.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp, strip, tick, waitFor } from "./app-driver.js";

async function main() {
	const dir = process.env.EIGHT_DATA_DIR ?? "";
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "providers.json"),
		JSON.stringify({
			activeProvider: "minimax",
			activeModel: process.env.SAVED_MODEL ?? "",
		}),
	);
	const app = await bootApp(120, 34, {});
	const s = await app.submit("/status");
	await waitFor(() => app.since(s).includes("Provider:"), "status line", 15000);
	await tick(500);
	const text = strip(app.raw());
	app.emit({
		phase: "relaunch",
		statusLine:
			/Provider: [^\n]*/
				.exec(app.since(s).replace(/[│]/g, ""))?.[0]
				?.split(/\s{2,}/)[0]
				?.trim() ?? "",
		onLocal: /Provider: [^\n]*\((ollama|8gent)\)/.test(text),
	});
	process.exit(0);
}
main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
