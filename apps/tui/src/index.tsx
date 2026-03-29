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

// Extract --name and --resume flags
const nameFlag = args.find(a => a.startsWith("--name="))?.split("=").slice(1).join("=");
const resumeFlag = args.find(a => a.startsWith("--resume="))?.split("=").slice(1).join("=")
  || (args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined);

// Filter out known flags from args passed to app
const filteredArgs = args.filter(a =>
  a !== "--infinite" && a !== "-infinite" && a !== "-i" &&
  !a.startsWith("--name=") && !a.startsWith("--resume=") &&
  a !== "--resume"
);
// Also remove the value after bare --resume
const cleanArgs: string[] = [];
for (let i = 0; i < filteredArgs.length; i++) {
  if (filteredArgs[i] === resumeFlag && i > 0 && args[args.indexOf(filteredArgs[i]) - 1] === "--resume") continue;
  cleanArgs.push(filteredArgs[i]);
}

// Render the TUI
render(<App initialCommand={command} args={cleanArgs.slice(1)} sessionName={nameFlag} sessionResume={resumeFlag} />);
