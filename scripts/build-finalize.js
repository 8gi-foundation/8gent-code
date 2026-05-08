#!/usr/bin/env node
// Cross-platform replacement for: chmod +x && bash copy-bundled-skills.sh && bash copy-bundled-sounds.sh
import { chmodSync, mkdirSync, readdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Inject shebang if missing (same logic as the old inline node -e)
const cliPath = join(ROOT, "dist", "cli.js");
const contents = readFileSync(cliPath, "utf-8");
if (!contents.startsWith("#!")) {
	writeFileSync(cliPath, "#!/usr/bin/env bun\n" + contents);
}

// chmod +x (Unix only - no-op on Windows)
if (platform() !== "win32") {
	chmodSync(cliPath, 0o755);
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
