/**
 * Harness for resume-context.test.tsx (#resume-amnesia). A stored session
 * (written 2024, two exchanges) is reopened in the real App and one more
 * question is sent; the test reads what the fake model was sent.
 * MODE=boot: launched with --resume <id>.
 * MODE=picker: launched plain; /resume lists it by its first prompt, Enter opens it.
 */
import * as fs from "node:fs";
import { SessionStore } from "../../../../packages/eight/session-store.js";
import { bootApp, tick, waitFor } from "./app-driver.js";
import { frameOf } from "./cast.js";

const MODE = process.env.MODE ?? "boot";
const ID = "resumeprobe1";
const WHEN = "2024-03-01T10:00:00.000Z";

function seed(): void {
	const dir = `${process.env.EIGHT_DATA_DIR}/sessions`;
	const s = SessionStore.create(
		{ id: ID, cwd: process.cwd(), model: "shell-test:1b", provider: "ollama", createdAt: WHEN },
		dir,
	);
	s.append({ role: "user", content: "Add a clamp helper and remember the codeword PINEAPPLE-42." });
	s.append({ role: "assistant", content: "Added clamp. Codeword stored: PINEAPPLE-42." });
	s.append({ role: "user", content: "Commit it." });
	s.append({ role: "assistant", content: "Committed as sha 1a2b3c4." });
	// Make every entry and the file look like they were written in 2024.
	const text = fs.readFileSync(s.file, "utf-8");
	fs.writeFileSync(s.file, text.replace(/"ts":"[^"]+"/g, `"ts":"${WHEN}"`));
	const old = new Date(WHEN);
	fs.utimesSync(s.file, old, old);
}

async function main() {
	seed();
	const app =
		MODE === "boot"
			? await bootApp(160, 60, { provider: "ollama", model: "none", resume: ID })
			: await bootApp(160, 60);
	let m: number;
	if (MODE === "picker") {
		m = await app.submit("/resume");
		await waitFor(() => app.since(m).includes("type to search"), "picker open");
		await tick(300);
		app.emit({ phase: "picker", screen: frameOf(app) });
		m = app.mark();
		for (const ch of "pineapple") {
			app.feed(ch);
			await tick(60);
		}
		await waitFor(() => app.since(m).includes("» pineapple"), "picker query");
		await tick(300);
		m = app.mark();
		app.feed("\r");
		await waitFor(() => app.since(m).includes("Transcript restored"), "resumed");
	} else {
		await waitFor(() => frameOf(app).includes("Resumed session"), "boot resume line");
	}
	await tick(500);
	m = await app.submit("What was the codeword and the sha?");
	await waitFor(() => app.since(m).includes("FAKE_DONE"), "reply", 30000);
	await tick(500);
	app.emit({ phase: "done", screen: frameOf(app) });
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
