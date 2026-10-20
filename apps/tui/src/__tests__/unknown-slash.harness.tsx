/**
 * Harness for unknown-slash.test.tsx (#4530). In the real App: an unknown
 * slash line is answered locally, a known command still runs, plain text
 * still reaches the model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootApp, tick, waitFor } from "./app-driver.js";

const REPLY = process.env.FAKE_REPLY ?? "";

async function main() {
	process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "unknown-slash-proj-")));
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

	// A template and a skill that appear after the registry was built still
	// reach the model: the guard reads both fresh at submit time.
	const home = os.homedir();
	fs.mkdirSync(path.join(home, ".8gent", "prompts"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".8gent", "prompts", "zz4536tpl.md"),
		"LATE-TEMPLATE-BODY-4536 $ARGUMENTS\n",
	);
	m = await app.submit("/zz4536tpl alpha");
	await waitFor(() => app.since(m).includes(REPLY), "late template reply", 30000);
	app.emit({ phase: "template", ok: !app.since(m).includes("Unknown command") });

	const skillDir = path.join(process.cwd(), ".agents", "skills", "latedemo");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		"---\nname: latedemo\ndescription: late skill\n---\nLATE-SKILL-BODY-4536\n",
	);
	m = await app.submit("/latedemo go");
	await waitFor(() => app.since(m).includes(REPLY), "late skill reply", 30000);
	app.emit({ phase: "skill", ok: !app.since(m).includes("Unknown command") });

	await app.submit("/quit");
	await waitFor(() => app.exited(), "exit after /quit");
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
