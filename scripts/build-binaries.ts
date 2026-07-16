#!/usr/bin/env bun
/**
 * build-binaries.ts - Compile 8gent to self-contained single-file binaries.
 *
 * Uses `bun build --compile` to embed the Bun runtime plus the whole
 * `bin/8gent.ts` module graph into one native executable per target. The
 * result needs no Bun, no Node, and no `npm install` on the user's machine.
 *
 * This is additive. The npm path (`bin/8gent-run.js` + `dist/cli.js`) is
 * untouched - these binaries ship alongside it.
 *
 * Targets (Bun cross-compile triples):
 *   bun-darwin-arm64            Apple Silicon
 *   bun-darwin-x64              Intel Mac
 *   bun-linux-x64               Linux x86_64 (glibc)
 *   bun-linux-arm64             Linux aarch64 (glibc)
 *   bun-windows-x64            Windows x86_64 (AVX2)
 *   bun-windows-x64-baseline    Windows x86_64 (pre-AVX2 CPUs)
 *
 * Usage:
 *   bun run scripts/build-binaries.ts                 # build every target
 *   bun run scripts/build-binaries.ts --only=bun-darwin-arm64,bun-linux-x64
 *   bun run scripts/build-binaries.ts --host          # only the current host target
 *
 * Output: dist/bin/<artifactName> (see TARGETS below).
 *
 * Signing is opt-in and skip-if-absent. On macOS, if EIGHT_MAC_SIGN_IDENTITY
 * is set, each darwin binary is codesigned with it. Windows/Linux signing
 * happens in the packaging scripts (Authenticode / GPG) since it wraps the
 * installer artifact, not the raw binary. See SIGNING.md.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENTRY = join(ROOT, "bin", "8gent.ts");
const OUT_DIR = join(ROOT, "dist", "bin");

interface Target {
	triple: string;
	artifact: string;
	os: "darwin" | "linux" | "windows";
}

const TARGETS: Target[] = [
	{ triple: "bun-darwin-arm64", artifact: "8gent-darwin-arm64", os: "darwin" },
	{ triple: "bun-darwin-x64", artifact: "8gent-darwin-x64", os: "darwin" },
	{ triple: "bun-linux-x64", artifact: "8gent-linux-x64", os: "linux" },
	{ triple: "bun-linux-arm64", artifact: "8gent-linux-arm64", os: "linux" },
	{ triple: "bun-windows-x64", artifact: "8gent-windows-x64.exe", os: "windows" },
	{
		triple: "bun-windows-x64-baseline",
		artifact: "8gent-windows-x64-baseline.exe",
		os: "windows",
	},
];

function hostTriple(): string | null {
	const p = osPlatform();
	const a = osArch();
	if (p === "darwin") return a === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
	if (p === "linux") return a === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
	if (p === "win32") return "bun-windows-x64";
	return null;
}

function parseArgs() {
	const args = process.argv.slice(2);
	let only: string[] | null = null;
	let host = false;
	for (const a of args) {
		if (a === "--host") host = true;
		else if (a.startsWith("--only="))
			only = a
				.slice("--only=".length)
				.split(",")
				.map((s) => s.trim());
	}
	return { only, host };
}

function selectTargets(): Target[] {
	const { only, host } = parseArgs();
	if (host) {
		const t = hostTriple();
		if (!t) {
			console.error(`Unsupported host platform: ${osPlatform()}/${osArch()}`);
			process.exit(1);
		}
		return TARGETS.filter((x) => x.triple === t);
	}
	if (only) {
		const set = new Set(only);
		const picked = TARGETS.filter((x) => set.has(x.triple));
		if (picked.length === 0) {
			console.error(
				`No known targets in --only. Known: ${TARGETS.map((t) => t.triple).join(", ")}`,
			);
			process.exit(1);
		}
		return picked;
	}
	return TARGETS;
}

function humanSize(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(1)}M`;
}

function build(target: Target): boolean {
	const outfile = join(OUT_DIR, target.artifact);
	console.log(`\n-> ${target.triple}  ->  dist/bin/${target.artifact}`);
	const res = spawnSync(
		"bun",
		["build", "--compile", `--target=${target.triple}`, ENTRY, "--outfile", outfile],
		{ stdio: "inherit", cwd: ROOT },
	);
	if (res.status !== 0) {
		console.error(`   FAILED (${target.triple})`);
		return false;
	}
	if (!existsSync(outfile)) {
		console.error(`   FAILED: ${outfile} not produced`);
		return false;
	}
	console.log(`   ok  ${humanSize(statSync(outfile).size)}`);
	maybeSignMac(target, outfile);
	return true;
}

// macOS codesigning is opt-in via env. Absent identity => unsigned binary
// (still runs locally; Gatekeeper will warn on other machines). Never fakes
// or hardcodes an identity. See SIGNING.md.
function maybeSignMac(target: Target, outfile: string) {
	if (target.os !== "darwin") return;
	const identity = process.env.EIGHT_MAC_SIGN_IDENTITY;
	if (!identity) {
		console.log("   (unsigned - set EIGHT_MAC_SIGN_IDENTITY to codesign; see SIGNING.md)");
		return;
	}
	if (osPlatform() !== "darwin") {
		console.log("   (skip codesign - not running on macOS)");
		return;
	}
	const res = spawnSync(
		"codesign",
		["--force", "--options", "runtime", "--timestamp", "--sign", identity, outfile],
		{ stdio: "inherit" },
	);
	if (res.status === 0) console.log(`   signed with '${identity}'`);
	else console.error("   codesign FAILED - shipping unsigned");
}

function main() {
	if (!existsSync(ENTRY)) {
		console.error(`Entry not found: ${ENTRY}`);
		process.exit(1);
	}
	mkdirSync(OUT_DIR, { recursive: true });
	const targets = selectTargets();
	console.log(`Building ${targets.length} target(s) from bin/8gent.ts`);
	let failures = 0;
	for (const t of targets) if (!build(t)) failures++;
	console.log("");
	if (failures > 0) {
		console.error(`${failures} target(s) failed.`);
		process.exit(1);
	}
	console.log(`All ${targets.length} target(s) built into dist/bin/`);
}

main();
