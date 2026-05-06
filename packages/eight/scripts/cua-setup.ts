#!/usr/bin/env bun
/**
 * First-time setup wizard for 8gent Computer (computer-use).
 *
 * Checks three prerequisites in order:
 *   1. cliclick installed (mouse/keyboard driver)
 *   2. Accessibility TCC granted to this terminal
 *   3. Screen Recording TCC granted to this terminal
 *
 * Opens the relevant System Settings pane for each missing grant.
 * Writes ~/.8gent/cua-configured on success so `cua-run` can gate on it.
 *
 * Run again at any time to re-diagnose a broken setup.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	checkPermissions,
	openPrivacyPane,
} from "../../hands/index";

// ── Paths ─────────────────────────────────────────────────────────────────────

const MARKER_DIR = join(homedir(), ".8gent");
const MARKER_PATH = join(MARKER_DIR, "cua-configured");

// ── Readline helper ───────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
	process.stdout.write(question);
	return new Promise((resolve) => {
		let buf = "";
		process.stdin.setRawMode?.(false);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			if (chunk === "\r" || chunk === "\n" || chunk.includes("\n")) {
				process.stdin.pause();
				process.stdin.removeListener("data", onData);
				resolve(buf.trim());
			} else if (chunk === "") {
				// Ctrl+C
				process.stdout.write("\n");
				process.exit(1);
			} else {
				buf += chunk;
				process.stdout.write(chunk);
			}
		};
		process.stdin.on("data", onData);
	});
}

async function pressEnter(msg = "Press Enter when done..."): Promise<void> {
	await prompt(`\n  ${msg} `);
	process.stdout.write("\n");
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function banner(): void {
	console.log("");
	console.log("  8gent Computer - Setup");
	console.log("  ──────────────────────");
	console.log("  This wizard grants the permissions 8gent needs to");
	console.log("  see your screen and control your mouse and keyboard.");
	console.log("");
}

function ok(msg: string): void {
	console.log(`  [OK] ${msg}`);
}

function warn(msg: string): void {
	console.log(`  [--] ${msg}`);
}

function step(n: number, total: number, label: string): void {
	console.log(`\n  Step ${n}/${total}: ${label}`);
	console.log("  " + "─".repeat(40));
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkCliclick(): boolean {
	const r = spawnSync("/usr/bin/which", ["cliclick"], { encoding: "utf-8" });
	return r.status === 0 && r.stdout.trim().length > 0;
}

async function ensureCliclick(): Promise<void> {
	step(1, 3, "cliclick (mouse + keyboard driver)");
	if (checkCliclick()) {
		ok("cliclick is installed.");
		return;
	}
	warn("cliclick is not installed.");
	console.log("");
	console.log("  cliclick handles mouse clicks, drags, and keystrokes.");
	console.log("  Without it, 8gent Computer can still screenshot and type,");
	console.log("  but drag and hover will fail.");
	console.log("");
	console.log("  Install now:");
	console.log("    brew install cliclick");
	console.log("");
	const ans = await prompt("  Install it now and press Enter, or type 'skip' to continue: ");
	if (ans.toLowerCase() !== "skip") {
		// Re-check
		if (checkCliclick()) {
			ok("cliclick found after install.");
		} else {
			warn("Still not found - continuing without it. Drag/hover will be limited.");
		}
	} else {
		warn("Skipped. Drag and hover will not work.");
	}
}

async function ensureAccessibility(): Promise<void> {
	step(2, 3, "Accessibility (click, type, key combos)");
	let perms = checkPermissions();

	if (perms.accessibility.granted) {
		ok(`Accessibility granted to ${perms.terminalApp}.`);
		return;
	}

	warn(`Accessibility is NOT granted to ${perms.terminalApp}.`);
	console.log("");
	console.log("  8gent needs Accessibility to click buttons, type text,");
	console.log("  and press key combinations on your behalf.");
	console.log("");
	console.log(`  Opening System Settings > Privacy & Security > Accessibility.`);
	console.log(`  Find "${perms.terminalApp}" in the list and toggle it ON.`);
	console.log("");

	openPrivacyPane("accessibility");
	await pressEnter(`Toggle "${perms.terminalApp}" ON in Accessibility, then press Enter...`);

	// Re-probe
	perms = checkPermissions();
	if (perms.accessibility.granted) {
		ok("Accessibility granted.");
	} else {
		warn(`Still denied. Detail: ${perms.accessibility.detail}`);
		console.log("  You may need to quit and re-open your terminal after granting.");
		console.log("  Run this setup again once the terminal is restarted.");
	}
}

async function ensureScreenRecording(): Promise<void> {
	step(3, 3, "Screen Recording (screenshot perception)");
	let perms = checkPermissions();

	if (perms.screenRecording.granted) {
		ok(`Screen Recording granted to ${perms.terminalApp}.`);
		return;
	}

	warn(`Screen Recording is NOT granted to ${perms.terminalApp}.`);
	console.log("");
	console.log("  8gent needs Screen Recording to take screenshots when the");
	console.log("  accessibility tree is not enough (image-heavy UIs, canvases, etc.).");
	console.log("");
	console.log("  Opening System Settings > Privacy & Security > Screen Recording.");
	console.log(`  Find "${perms.terminalApp}" in the list and toggle it ON.`);
	console.log("");

	openPrivacyPane("screen-recording");
	await pressEnter(`Toggle "${perms.terminalApp}" ON in Screen Recording, then press Enter...`);

	perms = checkPermissions();
	if (perms.screenRecording.granted) {
		ok("Screen Recording granted.");
	} else {
		warn(`Still denied. Detail: ${perms.screenRecording.detail}`);
		console.log("  You may need to restart your terminal after granting.");
		console.log("  Run this setup again once restarted.");
	}
}

// ── Save marker ───────────────────────────────────────────────────────────────

function saveMarker(): void {
	if (!existsSync(MARKER_DIR)) mkdirSync(MARKER_DIR, { recursive: true });
	writeFileSync(MARKER_PATH, JSON.stringify({
		configuredAt: new Date().toISOString(),
		version: 1,
	}));
}

// ── Final summary ─────────────────────────────────────────────────────────────

function finalSummary(): void {
	const perms = checkPermissions();
	const cli = checkCliclick();
	const allGood = perms.allGranted && cli;

	console.log("\n  ── Summary ─────────────────────────────────────────");
	console.log(`  cliclick:         ${cli ? "OK" : "missing (drag/hover limited)"}`);
	console.log(`  Accessibility:    ${perms.accessibility.granted ? "GRANTED" : "DENIED"}`);
	console.log(`  Screen Recording: ${perms.screenRecording.granted ? "GRANTED" : "DENIED"}`);
	console.log(`  Terminal:         ${perms.terminalApp}`);

	if (perms.allGranted) {
		saveMarker();
		console.log("\n  Setup complete. Run a goal with:");
		console.log("    bun run cua:run \"open TextEdit and type hello\"");
		console.log("");
	} else {
		console.log("\n  Some permissions are missing. Fix them and run this wizard again:");
		console.log("    bun run cua:setup");
		console.log("");
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	banner();

	// Check if already configured; offer quick re-check
	if (existsSync(MARKER_PATH)) {
		try {
			const m = JSON.parse(readFileSync(MARKER_PATH, "utf-8"));
			console.log(`  Previously configured at ${m.configuredAt}`);
		} catch {
			// ignore
		}
		const ans = await prompt("  Re-run full setup? [y/N] ");
		if (ans.toLowerCase() !== "y") {
			finalSummary();
			process.exit(0);
		}
		console.log("");
	}

	await ensureCliclick();
	await ensureAccessibility();
	await ensureScreenRecording();
	finalSummary();

	process.exit(0);
}

main();
