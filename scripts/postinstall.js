#!/usr/bin/env node
// Cross-platform postinstall: welcome message, optional bmad-method init,
// and (macOS only) a best-effort build of the bundled native AX bridge so
// the @8gent/eyes ax-native backend is ready on first use.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(
	"\n✨ 8gent installed! Just type: 8gent\n\n8gent auto-detects LM Studio, Ollama, and local models on first run.\nIf no model is found, a setup menu will walk you through it.\n",
);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
try {
	execFileSync(npx, ["bmad-method", "init", "--no-interactive"], { stdio: "ignore" });
} catch {
	// bmad-method is optional - failure is non-fatal
}

// macOS only: build the bundled AX bridge so @8gent/eyes works out of the
// box. Best-effort - failures are non-fatal (users can run the script
// manually). Skips when running inside CI to avoid slowing test pipelines.
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
