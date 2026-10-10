/**
 * Fake external coding-agent CLI used by the CliHarness test suite
 * (part of #2797). Behaviour is selected by the first argv element so tests
 * can exercise every mapping heuristic with known, deterministic output.
 *
 * Modes:
 *   echo-args   print each remaining argv element on its own line, exit 0
 *   lines       print two known lines of work output, exit 0
 *   fail        print "boom" to stderr, exit 3
 *   prompt      print an interactive confirmation prompt, then finish, exit 0
 *   stdin-echo  read stdin fully, print it prefixed with "STDIN:", exit 0
 *   hang        print one line, then sleep far longer than any test timeout
 *
 * Dogfood-defect modes (#2806-#2810):
 *   hang-quiet <token>   no output, sleep forever; <token> makes the process
 *                        findable in `ps` output
 *   hang-tree <token>    spawn a hang-quiet grandchild that INHERITS this
 *                        process's stdout/stderr pipes, then sleep forever
 *                        (the #2806 process-tree shape)
 *   orphan-pipe <token>  spawn a hang-quiet grandchild that inherits the
 *                        pipes, then EXIT 0 immediately - the grandchild is
 *                        reparented and keeps the pipe write end open
 *   trap-term <token>    ignore SIGTERM, sleep forever (kill-escalation shape)
 *   interactive          print a [y/N] prompt, then BLOCK on a real stdin
 *                        read; "y" -> print "confirmed, proceeding", exit 0;
 *                        anything else / EOF -> stderr "aborted", exit 1
 *   redos                print 10 pathological lines ("a" x 4000 + "!") that
 *                        trigger catastrophic backtracking in (a+)+$
 *   flood                print 5000 short lines, then "END-MARKER", exit 0
 */

import { fileURLToPath } from "node:url";

const [mode, ...rest] = process.argv.slice(2);
const SELF = fileURLToPath(import.meta.url);

function sleepForever(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 600_000));
}

function spawnHangQuietGrandchild(token: string): void {
	// The grandchild INHERITS this process's stdout/stderr (the adapter's
	// pipes), so the pipe write end stays open after this process dies.
	// unref() so the grandchild does not keep THIS process's event loop
	// alive - the orphan-pipe mode must genuinely exit while it runs.
	Bun.spawn({
		cmd: [process.execPath, SELF, "hang-quiet", token],
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	}).unref();
}

async function main(): Promise<void> {
	switch (mode) {
		case "echo-args": {
			for (const arg of rest) console.log(arg);
			return;
		}
		case "lines": {
			console.log("scanning repository");
			console.log("applying patch");
			return;
		}
		case "fail": {
			console.error("boom");
			process.exit(3);
			return;
		}
		case "prompt": {
			console.log("About to overwrite files. Continue? [y/N]");
			await new Promise((resolve) => setTimeout(resolve, 50));
			console.log("proceeding");
			return;
		}
		case "stdin-echo": {
			let input = "";
			for await (const chunk of process.stdin) {
				input += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			}
			console.log(`STDIN:${input}`);
			return;
		}
		case "hang": {
			console.log("started");
			await new Promise((resolve) => setTimeout(resolve, 60_000));
			return;
		}
		case "hang-quiet": {
			await sleepForever();
			return;
		}
		case "hang-tree": {
			spawnHangQuietGrandchild(rest[0] ?? "no-token");
			console.log("wrapper started");
			await sleepForever();
			return;
		}
		case "orphan-pipe": {
			spawnHangQuietGrandchild(rest[0] ?? "no-token");
			console.log("wrapper spawned grandchild, exiting");
			return;
		}
		case "trap-term": {
			process.on("SIGTERM", () => {
				console.error("ignoring SIGTERM");
			});
			console.log("started, trapping SIGTERM");
			await sleepForever();
			return;
		}
		case "interactive": {
			console.log("About to overwrite files. Continue? [y/N]");
			let answer = "";
			for await (const chunk of process.stdin) {
				answer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				if (answer.includes("\n")) break;
			}
			if (answer.trim().toLowerCase().startsWith("y")) {
				console.log("confirmed, proceeding");
				return;
			}
			console.error("aborted");
			process.exit(1);
			return;
		}
		case "redos": {
			const line = "a".repeat(4000) + "!";
			for (let i = 0; i < 10; i++) console.log(line);
			return;
		}
		case "flood": {
			for (let i = 0; i < 5000; i++) {
				console.log(`line ${i}: 0123456789abcdefghijklmnopqrstuvwxyz`);
			}
			console.log("END-MARKER");
			return;
		}
		default: {
			console.error(`unknown mode: ${mode}`);
			process.exit(64);
		}
	}
}

await main();
