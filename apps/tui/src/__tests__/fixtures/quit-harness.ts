/**
 * Child process for quit-leaves-nothing.test.ts. It starts one command the way
 * the model's run_command does (the real ToolExecutor.runCommand) and one the
 * way a typed `!cmd` does (the real startBang), then wires the exit handlers the
 * way apps/tui/src/app.tsx wires them, and waits. The test sends the exit.
 *
 * What is real: ToolExecutor.runCommand, startBang, killBangsOnExit,
 * installProgramStatusCleanup, quitNow, live-shells. What is a copy of app.tsx
 * and could drift: the two lambdas below (the quit command and the Ctrl-C key),
 * which have no importable form because they live inside the App component.
 *
 * stdout: one JSON line, {"runCommand":[pid,...],"bang":[pid,...]}, once both
 * commands have written their pids. Then a line "ready".
 * argv[2]: pid file directory.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killLiveShells } from "../../../../../packages/eight/live-shells";
import { ToolExecutor } from "../../../../../packages/eight/tools";
import { killBangsOnExit, startBang } from "../../lib/bang-command";
import { installProgramStatusCleanup } from "../../lib/program-status";
import { quitNow } from "../../lib/quit";

const dir = process.argv[2] as string;

// The tool's permission and hook layers are not under test here (as in tools-live-shell.test.ts).
const ex = new ToolExecutor(dir, "quit-harness");
(
	ex as unknown as { permissionManager: { checkPermission: () => string } }
).permissionManager.checkPermission = () => "allowed";
(ex as unknown as { hookManager: { executeHooks: () => Promise<void> } }).hookManager.executeHooks =
	async () => {};

// Each command writes its own pid (and a same-group background job) and then becomes sleep.
// A script file, because run_command refuses `;` chains and `$$` lines in its own text.
const script = (tag: string) => {
	const f = join(dir, `${tag}.sh`);
	writeFileSync(
		f,
		`#!/bin/sh\nsleep 302 &\necho $! > ${join(dir, `${tag}.bg`)}\necho $$ > ${join(dir, `${tag}.pid`)}\nexec sleep 300\n`,
	);
	chmodSync(f, 0o755);
	return f;
};

void ex
	.runCommand(`sh ${script("run")}`, 600)
	.then((r) => console.log(`run_command returned: ${r.slice(0, 120)}`));
const bangs = new Set<{ cancel: () => void }>();
bangs.add(startBang(`sh ${script("bang")}`, dir, 600_000));

const stopBangRuns = () => {
	for (const b of bangs) b.cancel();
	bangs.clear();
};

// app.tsx: useEffect(() => killBangsOnExit(...)) (the lines under "Never leave a shell command behind").
const uninstallBangs = killBangsOnExit(() => {
	stopBangRuns();
	killLiveShells("SIGKILL");
});
// app.tsx: useEffect(() => installProgramStatusCleanup(emitter)).
installProgramStatusCleanup({ clear: () => {} });

const unmount = () => {
	// Ink's exit(): React runs the effect cleanups.
	uninstallBangs();
	stopBangRuns();
};

function read(f: string): number[] {
	const p = join(dir, f);
	return existsSync(p)
		? readFileSync(p, "utf8")
				.split("\n")
				.map((s) => Number.parseInt(s, 10))
				.filter((n) => n > 1)
		: [];
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	for (const word of chunk.split("\n")) {
		if (word === "quit-command") {
			// app.tsx case "quit": stopBangRuns(); agent.cleanup(); exit(). No quitNow, no killLiveShells.
			stopBangRuns();
			unmount();
		}
		if (word === "ctrl-c") {
			// app.tsx Ctrl+C: stopBangRuns(); quitNow({abortAll: ... killLiveShells("SIGTERM")}).
			stopBangRuns();
			quitNow({
				abortAll: () => killLiveShells("SIGTERM"),
				unmount,
			});
		}
	}
});

const t0 = Date.now();
const wait = setInterval(() => {
	const r = {
		runCommand: [...read("run.pid"), ...read("run.bg")],
		bang: [...read("bang.pid"), ...read("bang.bg")],
	};
	if (r.runCommand.length === 2 && r.bang.length === 2) {
		clearInterval(wait);
		console.log(JSON.stringify(r));
		console.log("ready");
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(wait);
		console.log("never-ready");
	}
}, 50);
