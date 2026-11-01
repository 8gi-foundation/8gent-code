/**
 * Harness for provider-switch.test.tsx (#4682). In the real App:
 * - nothing the TUI starts, from boot through /provider, is its own runtime or entry
 *   (the local-model probe used to run process.execPath -e, which on the Node build is
 *   node with the TUI bundle's command line, synchronously, and froze the TUI);
 * - /provider minimax, with a key and a live model list (the parent's fake endpoint),
 *   picks a model from that list, never says the list returned no models, and is
 *   ready (readiness asks that endpoint, not the local Ollama).
 *
 * Every child_process call and Bun.spawn is recorded before the App module loads.
 */
import { bootApp, tick, waitFor } from "./app-driver.js";

const spawned: string[][] = [];
const record = (argv: unknown[]) => spawned.push(argv.map((a) => String(a)));
// The module object require() hands out, shared with the TUI's own require() calls.
const cpm = require("node:child_process") as Record<string, (...a: unknown[]) => unknown>;
for (const k of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
	const orig = cpm[k];
	cpm[k] = function (this: unknown, cmd: unknown, args?: unknown, ...rest: unknown[]) {
		record([cmd, ...(Array.isArray(args) ? args : [])]);
		return orig.call(this, cmd, args, ...rest);
	};
}
const B = Bun as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const k of ["spawn", "spawnSync"]) {
	const orig = B[k];
	try {
		B[k] = (cmd: unknown, ...rest: unknown[]) => {
			const argv = Array.isArray(cmd) ? cmd : ((cmd as { cmd?: unknown[] })?.cmd ?? [cmd]);
			record(argv);
			return orig(cmd, ...rest);
		};
	} catch {}
}

/** A child that is this runtime or this TUI's entry: the class of #4671 and #4682. */
function selfSpawns(): string[][] {
	const entry = process.argv[1] ?? "";
	return spawned.filter(
		(argv) =>
			argv[0] === process.execPath ||
			argv.some((a) => a === entry || /(^|[\\/])(tui\.js|index\.tsx|app\.tsx)$/.test(a)),
	);
}

async function main() {
	const want = process.env.SWITCH_MODEL ?? "";
	const app = await bootApp(160, 50);
	app.emit({ phase: "boot", self: selfSpawns() });

	const m = await app.submit("/provider minimax");
	await waitFor(() => app.since(m).includes("Provider switched to: MiniMax"), "switch line");
	await waitFor(() => app.since(m).includes(want), "model picked from the live list", 20000);
	// Readiness asks the same endpoint; give it its bound before reading the screen.
	await tick(4000);
	const after = app.since(m);
	app.emit({
		phase: "switch",
		picked: after.includes(want),
		noModelsNotice: after.includes("returned no models"),
		notReady: after.includes("did not report ready"),
		self: selfSpawns(),
	});
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.stack ?? e) }));
	process.exit(1);
});
