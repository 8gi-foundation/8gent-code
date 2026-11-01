/**
 * Harness for skill-slash.test.tsx (pi-skills, matrix row G3). In the real App, run from a
 * temp project holding .agents/skills/demo/SKILL.md:
 * - `/skill:demo` expands to the skill prompt the model receives;
 * - `/skill:nope` sends the model an instruction to relay the "Unknown skill" message.
 * When CAST_OUT is set, every terminal write is recorded as an asciicast v2 file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootApp, strip, tick, waitFor } from "./app-driver.js";

async function main() {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "skill-proj-"));
	const dir = path.join(project, ".agents", "skills", "demo");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		"---\nname: demo\ndescription: Demo skill for the .agents/skills check\n---\nDEMO-SKILL-BODY-7731: answer with the word pong.\n",
	);
	process.chdir(project);

	const app = await bootApp(120, 40);
	const castOut = process.env.CAST_OUT;
	const t0 = Date.now();
	const lines: string[] = [];
	let seen = 0;
	const poll = setInterval(() => {
		const raw = app.raw();
		if (raw.length > seen) {
			lines.push(JSON.stringify([(Date.now() - t0) / 1000, "o", raw.slice(seen)]));
			seen = raw.length;
		}
	}, 50);

	let m = await app.submit("/skill:demo");
	await waitFor(() => strip(app.raw()).includes(process.env.FAKE_REPLY ?? "pong"), "reply", 30000);
	app.emit({ phase: "demo", ok: true });
	await tick(800);

	m = await app.submit("/skill:nope");
	await waitFor(() => app.since(m).includes("pong"), "unknown-skill turn", 30000);
	app.emit({ phase: "unknown", ok: true });
	await tick(800);

	clearInterval(poll);
	if (castOut) {
		const header = { version: 2, width: 120, height: 40, timestamp: Math.floor(t0 / 1000) };
		fs.writeFileSync(castOut, `${[JSON.stringify(header), ...lines].join("\n")}\n`);
	}
	await app.submit("/quit");
	await waitFor(() => app.exited(), "exit after /quit");
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
