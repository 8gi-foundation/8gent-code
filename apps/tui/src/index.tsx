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
import { getModeManager } from "../../../packages/eight/modes.js";

// Parse CLI args
const args = process.argv.slice(2);
const command = args[0] || "repl";

// Log training proxy status if active
const trainingProxyUrl = process.env.TRAINING_PROXY_URL;
if (trainingProxyUrl) {
  console.log(`\x1b[36mTraining proxy: active (${trainingProxyUrl})\x1b[0m`);
}

// Check for --infinite flag (supports --infinite, -infinite, -i)
const hasInfiniteFlag = args.includes("--infinite") || args.includes("-infinite") || args.includes("-i");
if (hasInfiniteFlag) {
  enableInfiniteMode();
  console.log("\x1b[33m[∞] Infinite Loop mode enabled\x1b[0m\n");
}

// Check for --mode=<name> flag
const modeFlag = args.find(a => a.startsWith("--mode="));
if (modeFlag) {
  const modeName = modeFlag.split("=")[1];
  const modeManager = getModeManager();
  if (modeManager.setActiveMode(modeName)) {
    console.log(`\x1b[36m[Mode] ${modeManager.getActiveMode().name}: ${modeManager.getActiveMode().description}\x1b[0m\n`);
  } else {
    console.log(`\x1b[33m[Mode] Unknown mode "${modeName}" - using default (Code)\x1b[0m\n`);
  }
}

// Filter out the flags from args passed to app
const filteredArgs = args.filter(a => a !== "--infinite" && a !== "-infinite" && a !== "-i" && !a.startsWith("--mode="));

// Render the TUI
render(<App initialCommand={command} args={filteredArgs.slice(1)} />);
