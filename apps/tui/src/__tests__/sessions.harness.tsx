/**
 * Harness for sessions.test.tsx (#3918 E1, E3, E4, E7). In the real App, with
 * the fake model answering one turn:
 * - /export <file>.jsonl writes the session file; /branch lists its leaves;
 * - /tree opens the tree, Enter on an earlier entry continues from there;
 * - /fork <name> copies the conversation into a new session;
 * - /resume opens the picker; typing filters it; Enter opens a session;
 * - /import <file>.jsonl brings the exported session back.
 * Emits JSON lines and, last, the frames it captured.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";
import { frameOf, recorder } from "./cast.js";

const REPLY = process.env.FAKE_REPLY ?? "";
let screen: (() => string) | null = null;

async function main() {
	const app = await bootApp(160, 60);
	screen = () => frameOf(app);
	const rec = recorder(app);
	const exportFile = path.join(process.env.HOME ?? "", "exported-session.jsonl");

	let m = await app.submit("hello one");
	await waitFor(() => app.since(m).includes(REPLY), "first reply", 30000);
	await tick(500);
	rec.take("one turn answered");

	// E7: export the session file.
	m = await app.submit(`/export ${exportFile}`);
	await waitFor(() => app.since(m).includes("Session exported to"), "/export line");
	const exported = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, "utf-8") : "";
	const roles = exported
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { type: string; message?: { role: string } })
		.filter((l) => l.type === "message")
		.map((l) => l.message?.role);
	app.emit({
		phase: "export",
		roles,
		lines: exported.split("\n").filter(Boolean).length,
		hasUser: exported.includes("hello one"),
		hasReply: exported.includes(REPLY),
	});
	rec.take("/export <file>.jsonl");

	// E4: /branch lists the leaves of the tree store.
	m = await app.submit("/branch");
	await waitFor(
		() => app.since(m).includes("Branches (leaf entries, * = current):"),
		"/branch list",
	);
	app.emit({ phase: "branch", screen: app.since(m) });

	// E4: /tree, Up to the user message, Enter continues from it.
	m = await app.submit("/tree");
	await waitFor(() => app.since(m).includes("continue here"), "tree view");
	await tick(300);
	rec.take("/tree");
	app.emit({ phase: "tree", screen: app.since(m) });
	app.feed("\x1b[A"); // Up
	await tick(300);
	m = app.mark();
	app.feed("\r");
	await waitFor(() => app.since(m).includes("Continuing from entry"), "tree continue line");
	await tick(400);
	const afterTree = frameOf(app);
	app.emit({
		phase: "tree-continue",
		line: app.since(m).match(/Continuing from entry \S+ \((\d+) messages on this path\)/)?.[0],
		replyStillShown: afterTree.includes(REPLY),
	});
	rec.take("/tree: continued from the user message");

	// E4: /fork copies the path into a new session.
	m = await app.submit("/fork forked-copy");
	await waitFor(() => app.since(m).includes("Forked into session"), "/fork line");
	app.emit({ phase: "fork", line: app.since(m).match(/Forked into session [^\n]+/)?.[0] });
	rec.take("/fork forked-copy");

	// E3: /resume opens the picker; the fork is listed; typing filters; Enter opens.
	m = await app.submit("/resume");
	await waitFor(() => app.since(m).includes("type to search"), "picker open");
	await tick(300);
	rec.take("/resume picker");
	app.emit({ phase: "picker", screen: app.since(m) });
	m = app.mark();
	// One key per read, as a terminal sends them (the picker ignores a pasted chunk).
	for (const ch of "forked") {
		app.feed(ch);
		await tick(60);
	}
	await waitFor(() => app.since(m).includes("» forked"), "picker query");
	await tick(300);
	rec.take("/resume: typed a search");
	app.emit({ phase: "picker-filtered", screen: frameOf(app) });
	m = app.mark();
	app.feed("\r");
	await waitFor(() => app.since(m).includes('Resumed "forked-copy"'), "resumed the fork");
	app.emit({ phase: "resumed", line: app.since(m).match(/Resumed "forked-copy"[^\n]*/)?.[0] });
	rec.take("/resume: opened the fork");

	// E7: /import brings the exported file back as a new session.
	m = await app.submit(`/import ${exportFile}`);
	await waitFor(
		() => app.since(m).includes("Imported exported-session.jsonl as session"),
		"/import line",
	);
	app.emit({ phase: "import", line: app.since(m).match(/Imported [^\n]+/)?.[0] });
	rec.take("/import <file>.jsonl");

	// The picker now lists three sessions in this folder; Esc closes it.
	m = await app.submit("/resume");
	await waitFor(() => app.since(m).includes("type to search"), "picker open again");
	await tick(300);
	app.emit({ phase: "picker-three", screen: frameOf(app) });
	rec.take("/resume: three sessions");
	m = app.mark();
	app.feed("\x1b");
	await waitFor(() => app.since(m).includes("Type a command or ask a question"), "picker closed");
	app.emit({ phase: "frames", frames: rec.frames });
	process.exit(0);
}

main().catch((e) => {
	console.log(
		JSON.stringify({ phase: "error", message: String(e?.message ?? e), screen: screen?.() }),
	);
	process.exit(1);
});
