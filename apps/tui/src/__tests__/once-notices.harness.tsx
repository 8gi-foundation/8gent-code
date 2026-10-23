/**
 * Harness for once-notices.test.tsx (#4807). In the real App, resumed with a
 * saved session, on a clock too coarse to tell two notices apart (a slow
 * phone): how many times each notice reaches the screen. Emits JSON lines.
 */
import { SessionManager } from "../../../../packages/eight/session-manager.js";
import { bootApp, tick, waitFor } from "./app-driver.js";
import { frameOf } from "./cast.js";

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

async function main() {
	new SessionManager().save("0be12b45", [
		{ role: "user", content: "one" },
		{ role: "assistant", content: "two" },
		{ role: "user", content: "three" },
		{ role: "assistant", content: "four" },
	]);
	// Minute resolution: every notice made inside the same minute shares a timestamp.
	const realNow = Date.now;
	Date.now = () => Math.floor(realNow() / 60_000) * 60_000;
	const app = await bootApp(160, 60, { provider: "ollama", model: "none", resume: "0be12b45" });
	await tick(1500);
	app.emit({ phase: "resume", seen: count(frameOf(app), "Resumed session:") });

	// Open the other chat tabs and come back (Ctrl+2, Ctrl+3, Ctrl+1, Ctrl+2, Ctrl+1).
	for (const n of [2, 3, 1, 2, 1]) {
		app.feed(`\x1b[${48 + n};5u`);
		await tick(600);
	}
	app.emit({ phase: "tabs", seen: count(frameOf(app), "Resumed session:") });

	// Android: /voice on says "enabled" and the dictation line, each once.
	const m = await app.submit("/voice on");
	await waitFor(() => app.since(m).includes("TTS output enabled"), "/voice on");
	await tick(1000);
	const frame = frameOf(app);
	app.emit({
		phase: "voice-on",
		hints: count(frame, "tap the microphone key"),
		enabled: count(frame, "TTS output enabled"),
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
