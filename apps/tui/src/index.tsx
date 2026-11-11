#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * 8gent Code - Terminal UI
 *
 * A structured agentic coding environment.
 * Built with Ink (React for CLI).
 */

// Before anything else: on Termux, LD_PRELOAD comes back for child processes
// and direct spawns run through sh, before any module can start one (#4682).
import "./lib/termux-handoff.js";
// Then: BUN_BE_BUN must not reach this process's subprocesses.
import "./lib/strip-bun-be-bun.js";
import { bootTrace } from "./lib/boot-trace.js";
// First, before anything heavy loads: keys pressed before the first frame
// must reach the splash, not the line buffer (lib/early-input.ts).
import { markInkMounted } from "./lib/early-input.js";
// Then the colour policy, so NO_COLOR holds for every byte Ink draws
// (lib/colour-policy.ts).
import "./lib/colour-startup.js";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { render } from "ink";
import React from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { enableInfiniteMode } from "../../../packages/permissions/index.js";
import { setDurableEnabled } from "../../../packages/specifications/session/durable-ledger.js";
import { unattended } from "../../../packages/core/one-yes.js";
import { markClosed, offerRestore, reopenCommand } from "../../../packages/eight/open-sessions.js";
import { App } from "./app.js";
import { startMouse } from "./lib/mouse-wiring.js";
import { tuiRenderOptions } from "./lib/render-options.js";
import { ensureTerminalSize } from "./lib/terminal-size.js";
import { durableDefault, parseTuiArgv } from "./lib/tui-cli.js";
import { applyTerminalBackground } from "./theme.js";
import { probeTerminalBackground } from "./theme/terminal-probe.js";

const argv = process.argv.slice(2);
const parsed = parseTuiArgv(argv);

// Log training proxy status if active
const trainingProxyUrl = process.env.TRAINING_PROXY_URL;
if (trainingProxyUrl) {
	console.log(`\x1b[36mTraining proxy: active (${trainingProxyUrl})\x1b[0m`);
}

const hasInfiniteFlag = parsed.infiniteFlag;
if (hasInfiniteFlag) {
	enableInfiniteMode();
	console.log("\x1b[33m[∞] Infinite Loop mode enabled\x1b[0m\n");
}

// Durable turns are on by default in an interactive session, as in Pi Durable
// (docs/specs/DURABLE-TURNS.md, parity). `--no-durable` or EIGHT_DURABLE=0 opts
// out. Headless `-p` never reaches this file and keeps its own default (off).
setDurableEnabled(durableDefault(parsed.durable, process.env.EIGHT_DURABLE));

const command = parsed.positional[0] || "repl";
const passthroughArgs = parsed.positional.slice(1);

// Ask the terminal for its real background (OSC 11, #3754) before anything
// reads stdin, then fit the palette to it. Returns at once with no TTY (CI,
// pilots, pipes) and gives up after 100 ms on a terminal that never answers.
bootTrace("index-start", `argv=${argv.length}`);
if (ensureTerminalSize())
	bootTrace("terminal-size-fallback", "reported size missing or 0, using 80x24");
const terminalBg = await probeTerminalBackground();
if (terminalBg) applyTerminalBackground(terminalBg);

// Clear screen + home cursor so Ink's first frame paints at row 1.
// Without this, any stdout writes that happened during module load (eg
// async logs from agent construction or providers) leave the cursor below
// row 1, which clips the rounded-box header off the top of the viewport.
// Skip in non-TTY contexts (CI, smoke harness pipes) so test output stays clean.
if (process.stdout.isTTY) {
	process.stdout.write("\x1b[2J\x1b[H");
}

// Mouse (#3239): clicks on key caps, tabs and chips, drag-to-copy and the
// wheel. Installed before Ink so no mouse byte ever reaches its input parser.
startMouse();

// Sessions that were open when 8gent Code last stopped (#196): asked once, default No,
// and never with nobody at the terminal. The first yes resumes here, in its own folder;
// each further yes is named with the command that reopens it.
let sessionResume = parsed.sessionResume;
if (command === "repl" && sessionResume === undefined) {
	const interactive = !unattended();
	const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
	const accepted = await offerRestore({
		interactive,
		write: (line) => console.log(line),
		ask: (q) => (rl ? rl.question(q) : Promise.resolve("")),
	}).finally(() => rl?.close());
	for (const [i, s] of accepted.entries()) {
		if (i === 0) {
			sessionResume = s.id;
			if (existsSync(s.cwd)) process.chdir(s.cwd);
		} else console.log(`To reopen ${s.id}: ${reopenCommand(s)}`);
	}
}

// Render the TUI
bootTrace("ink-render-call");
const instance = render(
	<App
		initialCommand={command}
		args={passthroughArgs}
		sessionName={parsed.sessionName}
		sessionResume={sessionResume}
		cliProvider={parsed.provider}
		cliModel={parsed.model}
		cliAutoApprove={parsed.yes}
	/>,
	tuiRenderOptions(),
);
// Runs when render() returns, before Ink's useEffect attaches stdin: a stall
// inside Ink's own mount is not covered by the watchdog.
markInkMounted();
// A deliberate quit closes the open-session record; a restart or a kill leaves it.
void instance.waitUntilExit().then(() => markClosed());
