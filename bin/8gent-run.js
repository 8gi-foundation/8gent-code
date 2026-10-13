#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "dist", "cli.js");
// Never let the user's cwd steer the runtime: a workspace bunfig.toml `preload`
// or .env would run or set things before 8gent snapshots its security env
// (#4013). Use the package's own empty bunfig and no env file.
const bunfig = join(__dirname, "bunfig.empty.toml");
const SAFE_BUN = ["--no-install", "--no-env-file", `--config=${bunfig}`];

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

const result = spawnSync("bun", [...SAFE_BUN, cli, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});

// One spawn: a missing Bun shows up as ENOENT here, so no separate probe runs first (A4).
if (result.error && result.error.code === "ENOENT") {
	console.error(NO_BUN);
	process.exit(1);
}

process.exit(result.status ?? 0);
