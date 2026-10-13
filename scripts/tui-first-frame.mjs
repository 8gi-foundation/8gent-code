#!/usr/bin/env node
// Launch a compiled 8gent binary's TUI under a real pseudo-terminal (ConPTY on
// Windows) from a hostile working directory, and assert two things (#2975, #3894):
//   1. the first frame renders (a known TUI string appears), and
//   2. the cwd bunfig.toml preload never ran.
// Used by windows-smoke.yml; scripts/smoke-compiled.sh does the same with a
// python pty on POSIX. Needs node-pty (an optionalDependency, installed by `bun install`).
//
//   node scripts/tui-first-frame.mjs <path-to-binary> [seconds]
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve(process.argv[2] ?? "");
const seconds = Number(process.argv[3]) || 90;
if (!process.argv[2] || !existsSync(bin)) {
	console.error("usage: tui-first-frame.mjs <binary> [seconds]");
	process.exit(2);
}
const require = createRequire(import.meta.url);
const pty = require("node-pty");

const root = mkdtempSync(join(tmpdir(), "tui-frame-"));
const home = join(root, "home");
const hostile = join(root, "hostile");
mkdirSync(home);
mkdirSync(hostile);
const marker = join(root, "PWNED");
writeFileSync(join(hostile, "evil.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
writeFileSync(join(hostile, "bunfig.toml"), 'preload = ["./evil.js"]\n');
writeFileSync(join(hostile, ".env"), "HOSTILE=from-dotenv\n");

// Allowlist, no CI variables (Ink suppresses rendering under CI), no Bun on PATH.
const sys = process.env.SystemRoot ?? "C:\\Windows";
const env = {
	SystemRoot: sys,
	PATH: `${sys}\\System32;${sys}`,
	USERPROFILE: home,
	HOME: home,
	TEMP: root,
	TMP: root,
	TERM: "xterm-256color",
};

const FIRST = /I'm 8gent|8GENT FM/;
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const term = pty.spawn(bin, ["tui", "--no-pet"], { name: "xterm-256color", cols: 120, rows: 40, cwd: hostile, env });
let buf = "";
let exited = null;
term.onExit((e) => (exited = e.exitCode));
term.onData((d) => {
	buf += d;
	if (d.includes("\x1b]11;?")) term.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
});

const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline && exited === null && !FIRST.test(strip(buf))) {
	await new Promise((r) => setTimeout(r, 500));
}
const text = strip(buf);
const ok = FIRST.test(text);
const pwned = existsSync(marker);
try {
	term.kill();
} catch {}
await new Promise((r) => setTimeout(r, 500));
try {
	rmSync(root, { recursive: true, force: true });
} catch {}

if (/TUI entry not found|Could not start the TUI/.test(text)) {
	console.error("FAIL  the binary could not start the TUI");
	console.error(text.slice(-800));
	process.exit(1);
}
if (pwned) {
	console.error("FAIL  cwd bunfig.toml preload ran");
	process.exit(1);
}
if (!ok) {
	console.error(`FAIL  no TUI first frame within ${seconds}s (exit ${exited})`);
	console.error(text.slice(-800));
	process.exit(1);
}
console.log("PASS  TUI first frame rendered; cwd bunfig.toml and .env not loaded");
