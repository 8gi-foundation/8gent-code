/**
 * The /model picker in the real app on a short terminal (apps/tui, #140). Serves
 * 14 models, boots at 30 rows, shrinks to HARNESS_ROWS, opens /model, and emits the
 * frame as drawn at open, after two Down presses, at the end of the list, and
 * after Enter (then the line the app printed, read back at 30 rows). The test reads those frames; nothing here judges them.
 */
import { bootApp, settle, tick, waitFor } from "./app-driver.js";

const MODELS = Array.from({ length: 14 }, (_, i) => `model-${String(i).padStart(2, "0")}:latest`);
const CURRENT = MODELS[5];

async function main() {
	const rows = Number(process.env.HARNESS_ROWS ?? 14);
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				return Response.json({ models: MODELS.map((name) => ({ name, model: name, size: 1 })) });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	process.env.OLLAMA_HOST = base;
	process.env.OLLAMA_BASE_URL = base;
	process.env.EIGHT_DECIDE_OLLAMA_HOST = base;

	const app = await bootApp(80, 30, { provider: "ollama", model: CURRENT });
	app.resize(80, rows);
	await tick(500);
	await app.submit("/model");
	await waitFor(
		() => /model-\d\d|Window too short/.test(app.frame().join("\n")),
		"picker drawn",
		20000,
	);
	await settle();
	const open = app.frame();
	const down = async (n: number) => {
		for (let i = 0; i < n; i++) {
			app.feed("\u001B[B");
			await tick(120);
		}
		await settle();
		return app.frame();
	};
	const afterTwo = await down(2);
	const atEnd = await down(MODELS.length);
	app.feed("\r");
	await tick(1500);
	const after = app.frame();
	// A 10-row chat has no room to draw the confirmation line, so read it back taller.
	app.resize(80, 30);
	await tick(800);
	const afterTall = app.frame();
	app.emit({
		phase: "frames",
		rows,
		current: CURRENT,
		open,
		afterTwo,
		atEnd,
		after,
		switchedLine: afterTall.join("\n").match(/Model switched to: \S+/)?.[0] ?? null,
	});
	process.exit(0);
}
main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
