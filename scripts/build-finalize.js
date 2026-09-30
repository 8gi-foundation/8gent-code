#!/usr/bin/env node
// Cross-platform replacement for: chmod +x && bash copy-bundled-skills.sh && bash copy-bundled-sounds.sh
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	copyFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { findBakedRoots, unbakeBuildPaths } from "./lib/unbake-build-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Strip build-machine absolute paths from both bundles (#3219). Without this,
// dist/cli.js shipped `__dirname = "/Users/<builder>/8gent-code/..."` to npm.
// Roots: the checkout, its real path, and the real directory node_modules
// resolves into (a symlinked node_modules reports paths from its target).
const buildRoots = [ROOT];
try {
	buildRoots.push(realpathSync(ROOT));
} catch {}
try {
	buildRoots.push(dirname(realpathSync(join(ROOT, "node_modules"))));
} catch {}
for (const name of ["cli.js", "tui.js"]) {
	const file = join(ROOT, "dist", name);
	if (!existsSync(file)) continue;
	const { code, replaced } = unbakeBuildPaths(readFileSync(file, "utf-8"), buildRoots);
	const left = findBakedRoots(code, buildRoots, [homedir()]);
	if (left.length > 0) {
		console.error(
			`[build-finalize] dist/${name} still contains build-machine paths: ${left.join(", ")}`,
		);
		process.exit(1);
	}
	writeFileSync(file, code);
	console.log(`[unbake-build-paths] dist/${name}: rewrote ${replaced} build-machine paths`);
}

// Inject shebang if missing (same logic as the old inline node -e)
// (`build:tui` builds dist/tui.js alone, so dist/cli.js may not exist.)
const cliPath = join(ROOT, "dist", "cli.js");
if (existsSync(cliPath)) {
	const contents = readFileSync(cliPath, "utf-8");
	if (!contents.startsWith("#!")) {
		writeFileSync(cliPath, "#!/usr/bin/env bun\n" + contents);
	}

	// chmod +x (Unix only - no-op on Windows)
	if (platform() !== "win32") {
		chmodSync(cliPath, 0o755);
	}
}

// copy-bundled-skills: packages/skills/*/SKILL.md -> dist/skills/*/SKILL.md
const skillsSrc = join(ROOT, "packages", "skills");
const skillsDest = join(ROOT, "dist", "skills");
mkdirSync(skillsDest, { recursive: true });
if (existsSync(skillsSrc)) {
	for (const name of readdirSync(skillsSrc)) {
		const skillFile = join(skillsSrc, name, "SKILL.md");
		if (existsSync(skillFile)) {
			mkdirSync(join(skillsDest, name), { recursive: true });
			copyFileSync(skillFile, join(skillsDest, name, "SKILL.md"));
		}
	}
}

// copy-bundled-sounds: apps/tui/sounds/*.{mp3,wav} -> dist/sounds/
const soundsSrc = join(ROOT, "apps", "tui", "sounds");
const soundsDest = join(ROOT, "dist", "sounds");
if (existsSync(soundsSrc)) {
	mkdirSync(soundsDest, { recursive: true });
	let copied = 0;
	for (const f of readdirSync(soundsSrc)) {
		if (f.endsWith(".mp3") || f.endsWith(".wav")) {
			copyFileSync(join(soundsSrc, f), join(soundsDest, f));
			copied++;
		}
	}
	console.log(`[copy-bundled-sounds] copied ${copied} files to dist/sounds/`);
}

// Terminal tabs (#3256): the bundled TUI spawns `pty-bridge.cjs` from next to
// itself (dist/), under Node. Bundling cannot inline it (it is a separate
// process), so ship it beside the bundle. Without this copy every terminal
// tab in an npm install died on "Cannot find module .../dist/pty-bridge.cjs".
const bridgeSrc = join(ROOT, "packages", "terminal-tab", "pty-bridge.cjs");
if (existsSync(bridgeSrc)) {
	copyFileSync(bridgeSrc, join(ROOT, "dist", "pty-bridge.cjs"));
	console.log("[copy-pty-bridge] copied pty-bridge.cjs to dist/");
}
