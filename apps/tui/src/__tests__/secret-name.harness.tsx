/**
 * Harness for secret-name.test.tsx (#5098). In the real App: a saved name and
 * tab title that look like a key are reset at launch with one notice, /rename
 * refuses a key and still takes a normal name.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";

const KEY = process.env.SECRET_KEY ?? "";

async function main() {
	process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "secret-name-proj-")));
	const dir = path.join(os.homedir(), ".8gent");
	fs.mkdirSync(path.join(dir, "tabs"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({ agents: { names: { orchestrator: KEY } } }),
	);
	const now = new Date().toISOString();
	const tab = (id: string, role: string, title: string, active: boolean) => ({
		id,
		type: "chat",
		title,
		active,
		createdAt: now,
		lastAccessedAt: now,
		pinned: true,
		data: { role },
	});
	fs.writeFileSync(
		path.join(dir, "tabs", "state.json"),
		JSON.stringify([
			tab("tab-orchestrator", "orchestrator", KEY, true),
			tab("tab-engineer", "engineer", KEY, false),
		]),
	);

	const app = await bootApp(160, 60);
	await waitFor(
		() => app.frame().join("\n").includes("looked like a key, so I reset it"),
		"scrub notice",
	);
	const screen = app.frame().join("\n");
	app.emit({
		phase: "scrub",
		ok: !screen.includes(KEY) && screen.includes("revoke it with your provider"),
	});
	await tick(600);
	const settingsOnDisk = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
	const stateOnDisk = fs.readFileSync(path.join(dir, "tabs", "state.json"), "utf-8");
	app.emit({ phase: "disk", ok: !settingsOnDisk.includes(KEY) && !stateOnDisk.includes(KEY) });

	let m = await app.submit(`/rename ${KEY}`);
	await waitFor(
		() => app.since(m).includes("That looks like a key, so I did not save it"),
		"refusal",
	);
	await tick(800);
	const after = fs.readFileSync(path.join(dir, "tabs", "state.json"), "utf-8");
	app.emit({ phase: "rename-refused", ok: !after.includes(KEY) });

	m = await app.submit("/rename Zoë 🙂 Notes");
	await waitFor(() => app.since(m).includes('Tab renamed to "Zoë 🙂 Notes"'), "rename ok");
	await tick(800);
	const saved = fs.readFileSync(path.join(dir, "tabs", "state.json"), "utf-8");
	app.emit({ phase: "rename-ok", ok: saved.includes("Zoë 🙂 Notes") });

	await app.submit("/quit");
	await waitFor(() => app.exited(), "exit after /quit");
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
