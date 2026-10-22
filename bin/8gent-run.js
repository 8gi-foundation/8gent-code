#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTooOld, tooOldMessage } from "./node-version.js";
import { nodeExecPath } from "./termux-exec.js";

// An 8gent tool shell marks its child env (packages/permissions/nested-guard.ts); a second
// 8gent inside it refuses to start (#4715). Kept inline: this file is plain JS, run before the build.
if (process.env.EIGHT_PARENT_SESSION !== undefined) {
	process.stderr.write("8gent: refusing to start inside an 8gent tool shell\n");
	process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "dist", "cli.js");
// Never let the user's cwd steer the runtime: a workspace bunfig.toml `preload`
// or .env would run or set things before 8gent snapshots its security env
// (#4013). Use the package's own empty bunfig and no env file.
const bunfig = join(__dirname, "bunfig.empty.toml");
const SAFE_BUN = ["--no-env-file", `--config=${bunfig}`];

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

// Boot trace (#4540): same file as apps/tui/src/lib/boot-trace.ts. Never throws.
if (process.env.EIGHT_BOOT_TRACE !== "0") {
	try {
		const file = join(homedir(), ".8gent", "logs", "tui-boot.log");
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(
			file,
			`${new Date().toISOString()} +0ms pid=${process.pid} launcher-spawn platform=${process.platform} node=${process.version}\n`,
		);
	} catch {}
}

// Bun if it is installed (unchanged path); otherwise the Node build (dist/node/*),
// which needs Node 22.5+ for node:sqlite. --experimental-sqlite is required before 22.13.
const nodeCli = join(__dirname, "..", "dist", "node", "cli.js");
const wantNode = process.env.EIGHT_RUNTIME === "node";
let result = wantNode
	? { error: { code: "ENOENT" } }
	: spawnSync("bun", [...SAFE_BUN, cli, ...process.argv.slice(2)], {
			stdio: "inherit",
			env: process.env,
		});

// One spawn: a missing Bun shows up as ENOENT here, so no separate probe runs first (A4).
if (result.error && result.error.code === "ENOENT") {
	if (!existsSync(nodeCli)) {
		console.error(NO_BUN);
		process.exit(1);
	}
	if (nodeTooOld(process.versions.node)) {
		console.error(tooOldMessage(process.versions.node));
		process.exit(1);
	}
	// Absolute node, never /system/bin/linker64 (Termux system linker exec, #4682).
	result = spawnSync(
		nodeExecPath(),
		[
			"--experimental-sqlite",
			"--disable-warning=ExperimentalWarning",
			nodeCli,
			...process.argv.slice(2),
		],
		{ stdio: "inherit", env: process.env },
	);
}

process.exit(result.status ?? 0);
