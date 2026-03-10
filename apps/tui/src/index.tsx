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

// Parse CLI args
const args = process.argv.slice(2);
const command = args[0] || "repl";

// Render the TUI
render(<App initialCommand={command} args={args.slice(1)} />);
