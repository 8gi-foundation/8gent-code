#!/usr/bin/env node
// Cross-platform postinstall: welcome message, and (macOS only) a best-effort
// build of the bundled native AX bridge so the @8gent/eyes ax-native backend
// is ready on first use.
//
// This script performs no network access.
//
// It previously ran `npx bmad-method init --no-interactive`, which fetched and
// executed an unpinned package from the public registry during install. That is
// disallowed twice over:
//
//   - 8GI-SECURITY.md 3.2 - "No install scripts: package.json must not contain
//     preinstall, postinstall, or prepare scripts that execute arbitrary code
//     without review."
//   - Constitution Article 6, Privacy is sacred - nothing reaches the network on
//     the user's behalf without an explicit opt-in. The rule is aimed at data
//     leaving the machine, and an install-time fetch is the same shape.
//
// It was also already optional: the original wrapped it in try/catch and
// swallowed every failure. Removing it changes nothing about whether 8gent
// works. If you want bmad-method, ask for it:
//
//   npx bmad-method init --no-interactive
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(
	"\n✨ 8gent installed! Just type: 8gent\n\n8gent auto-detects LM Studio, Ollama, and local models on first run.\nIf no model is found, a setup menu will walk you through it.\n",
);

// macOS only: build the bundled AX bridge so @8gent/eyes works out of the
// box. Best-effort - failures are non-fatal (users can run the script
// manually). Skips when running inside CI to avoid slowing test pipelines.
//
// This compiles a script that ships inside the package rather than fetching
// anything, so it is not a supply-chain surface. It stays opt-out via
// EIGHT_SKIP_BRIDGE_BUILD=1 for installs that need to be fully inert.
if (process.platform === "darwin" && !process.env.CI && process.env.EIGHT_SKIP_BRIDGE_BUILD !== "1") {
	const buildScript = join(__dirname, "..", "packages", "eyes", "native", "build.sh");
	if (existsSync(buildScript)) {
		const r = spawnSync("bash", [buildScript], { stdio: "ignore" });
		if (r.status === 0) {
			console.log("✓ Built bundled eyes bridge (~/.8gent/bin/8gent-ax-bridge).\n");
		} else {
			console.log(
				"⚠ Could not build the eyes bridge automatically. Run `bash packages/eyes/native/build.sh` manually if you need the perception backend.\n",
			);
		}
	}
}
