/**
 * Child process for scripts/perf/startup.ts: mount the real App on the fake TTY
 * (apps/tui/src/__tests__/app-driver.tsx) and report how long it took to reach
 * the normal input prompt. FAKE-TTY, IN-PROCESS: this is not terminal startup.
 * performance.now() is measured from process start, so ready_ms is
 * process-start to prompt.
 */
import { bootApp } from "../../apps/tui/src/__tests__/app-driver.js";

// bootApp types "/skip all" through first-run setup and waits a fixed 800 ms
// plus a 50 ms echo tick before returning. Those are scripted waits, not app
// work, so they are reported separately and subtracted in ready_ms.
const SCRIPTED_WAIT_MS = 850;

async function main() {
	const t0 = performance.now();
	await import("ink");
	await import("../../apps/tui/src/app.js");
	const importMs = performance.now() - t0;
	const t1 = performance.now();
	await bootApp(160, 44);
	const bootMs = performance.now() - t1;
	const readyAt = performance.now();
	console.log(
		JSON.stringify({
			phase: "ready",
			import_ms: importMs,
			boot_raw_ms: bootMs,
			scripted_wait_ms: SCRIPTED_WAIT_MS,
			ready_ms: readyAt - SCRIPTED_WAIT_MS,
		}),
	);
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
