#!/usr/bin/env node
// Cross-platform postinstall: print welcome message + run bmad-method init safely
import { execFileSync } from "node:child_process";

console.log(
	"\n✨ 8gent installed! Just type: 8gent\n\n8gent auto-detects LM Studio, Ollama, and local models on first run.\nIf no model is found, a setup menu will walk you through it.\n",
);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
try {
	execFileSync(npx, ["bmad-method", "init", "--no-interactive"], { stdio: "ignore" });
} catch {
	// bmad-method is optional - failure is non-fatal
}
