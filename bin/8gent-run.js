#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "dist", "cli.js");

const NO_BUN = `
  8gent requires Bun to run. Install it with one command:

  Mac / Linux:
    curl -fsSL https://bun.sh/install | bash

  Windows (PowerShell):
    powershell -c "irm bun.sh/install.ps1 | iex"

  Then restart your terminal and run: 8gent
`;

if (!existsSync(cli)) {
	console.error(`
  8gent build not found at ${cli}
  Run: npm run build
`);
	process.exit(1);
}

const result = spawnSync("bun", [cli, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});

// One spawn: a missing Bun shows up as ENOENT here, so no separate probe runs first (A4).
if (result.error && result.error.code === "ENOENT") {
	console.error(NO_BUN);
	process.exit(1);
}

process.exit(result.status ?? 0);
