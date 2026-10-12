/**
 * Harness for prompt-template.test.tsx (#3918 G4). With a template file in
 * the throwaway HOME, in the real App: typing `/rev` lists /review with its
 * description in the menu, and sending `/review src/app.ts strict` sends the
 * template's text with the arguments filled in (the test reads what the
 * fake model was sent).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";
import { frameOf, recorder } from "./cast.js";

const REPLY = process.env.FAKE_REPLY ?? "";
let screen: (() => string) | null = null;

async function main() {
	const dir = path.join(process.env.HOME ?? "", ".8gent", "prompts");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "review.md"),
		"---\ndescription: Review a file for bugs\n---\nReview $1 for correctness bugs. Mode: $2.\n",
	);
	const app = await bootApp(160, 50);
	screen = () => frameOf(app);
	const rec = recorder(app);

	let m = app.mark();
	app.feed("/rev");
	await waitFor(() => app.since(m).includes("/review Review a file for bugs"), "menu row");
	await tick(300);
	rec.take("typed /rev: the template is in the menu");
	app.emit({ phase: "menu", screen: frameOf(app) });
	app.feed("iew src/app.ts strict");
	await waitFor(() => app.since(m).includes("/review src/app.ts strict"), "typed command");
	await tick(100);
	m = app.mark();
	app.feed("\r");
	await waitFor(() => app.since(m).includes(REPLY), "reply", 30000);
	await tick(400);
	rec.take("/review src/app.ts strict sent, answered");
	app.emit({ phase: "sent", ok: true });

	m = await app.submit("/help all");
	await waitFor(() => app.since(m).includes("/<template> ..."), "/help all template line");
	rec.take("/help all");
	app.emit({ phase: "frames", frames: rec.frames });
	process.exit(0);
}

main().catch((e) => {
	console.log(
		JSON.stringify({ phase: "error", message: String(e?.message ?? e), screen: screen?.() }),
	);
	process.exit(1);
});
