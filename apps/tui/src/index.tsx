#!/usr/bin/env bun
/**
 * 8gent Code - Terminal UI
 *
 * A structured agentic coding environment.
 * Built with Ink (React for CLI).
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { enableInfiniteMode } from "../../../packages/permissions/index.js";
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
