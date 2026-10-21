/**
 * #4720 harness: a plain launch (no --provider), Ollama down, only a MiniMax key
 * (a fake endpoint served by the test). Records what the screen says as it goes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp, strip, tick, waitFor } from "./app-driver.js";

async function main() {
	const want = process.env.SWITCH_MODEL ?? "";
	const cols = Number(process.env.HARNESS_COLS ?? 52);
	const app = await bootApp(cols, Number(process.env.HARNESS_ROWS ?? 34), {});
	const m0 = 0;
	const whole = () => strip(app.raw());
	await app.submit(process.env.FIRST_TASK ?? "say ready");
	// The rule switches, says so once, and the task runs: no /provider step.
	await waitFor(() => whole().includes("using MiniMax"), "auto-switch line", 30000).catch((e) => {
		console.log(JSON.stringify({ phase: "debug", screen: whole().slice(-2500) }));
		throw e;
	});
	await tick(2500);
	const afterTask = app.since(m0);
	const s = await app.submit("/status");
	await tick(800);
	const status = app.since(s);
	// The choice made by the rule is on disk for the next launch.
	let saved: { activeProvider?: string; activeModel?: string } = {};
	try {
		saved = JSON.parse(
			fs.readFileSync(path.join(process.env.EIGHT_DATA_DIR ?? "", "providers.json"), "utf-8"),
		);
	} catch {}
	app.emit({
		phase: "auto",
		saved: { provider: saved.activeProvider, model: saved.activeModel },
		line: /\S[^\n]* is not running; using MiniMax[^\n]*/.exec(afterTask)?.[0] ?? "",
		pickerShown: afterTask.includes("Select Provider"),
		notReady: afterTask.includes("8gent not ready"),
		noModelCard: afterTask.includes("No model yet"),
		model: want ? afterTask.includes(want) : null,
		statusLine: /Provider: [^\n]*(\n[^\n]*)?/.exec(status.replace(/[│]/g, ""))?.[0] ?? "",
		statusHasProvider: /MiniMax/.test(status),
	});
	process.exit(0);
}
main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
