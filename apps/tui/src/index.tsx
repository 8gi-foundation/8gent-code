#!/usr/bin/env bun
/**
 * 8gent Code - Terminal UI
 *
 * A structured agentic coding environment.
 * Built with Ink (React for CLI).
 */

import { render } from "ink";
import React from "react";
import { enableInfiniteMode } from "../../../packages/permissions/index.js";
import { App } from "./app.js";
import { parseTuiArgv } from "./lib/tui-cli.js";

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

const command = parsed.positional[0] || "repl";
const passthroughArgs = parsed.positional.slice(1);

// Clear screen + home cursor so Ink's first frame paints at row 1.
// Without this, any stdout writes that happened during module load (eg
// async logs from agent construction or providers) leave the cursor below
// row 1, which clips the rounded-box header off the top of the viewport.
// Skip in non-TTY contexts (CI, smoke harness pipes) so test output stays clean.
if (process.stdout.isTTY) {
	process.stdout.write("\x1b[2J\x1b[H");
}

// Render the TUI
render(
	<App
		initialCommand={command}
		args={passthroughArgs}
		sessionName={parsed.sessionName}
		sessionResume={parsed.sessionResume}
		cliProvider={parsed.provider}
		cliModel={parsed.model}
		cliAutoApprove={parsed.yes}
	/>,
);
