#!/usr/bin/env bun
/**
 * Apple Foundation Model - Bridge Installer
 *
 * Detects host compatibility (macOS 26+ Tahoe, Apple Silicon, Swift toolchain),
 * builds the `apple-foundation-bridge` Swift binary from source, and installs
 * it to `~/.8gent/bin/apple-foundation-bridge` where the runtime client picks
 * it up. Idempotent — re-running after a version bump rebuilds cleanly.
 *
 * Run:  bun run scripts/install-apple-foundation.ts
 *
 * Exit codes:
 *   0  success
 *   1  host not supported (wrong platform/arch/OS version)
 *   2  Swift toolchain missing
 *   3  build failed
 *   4  install (copy) failed
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { homedir, release } from "os";
import { join, resolve } from "path";

const BRIDGE_SOURCE_DIR = resolve(import.meta.dir, "..", "bin", "apple-foundation-bridge");
const BUILD_BINARY = join(BRIDGE_SOURCE_DIR, ".build", "release", "AppleFoundationBridge");
const INSTALL_DIR = join(homedir(), ".8gent", "bin");
const INSTALL_PATH = join(INSTALL_DIR, "apple-foundation-bridge");

function log(msg: string) {
  process.stdout.write(`[apple-foundation] ${msg}\n`);
}

function fail(code: number, msg: string): never {
  process.stderr.write(`[apple-foundation] ERROR: ${msg}\n`);
  process.exit(code);
}

function checkHost(): void {
  if (process.platform !== "darwin") {
    fail(1, `Apple Foundation Model requires macOS. Current platform: ${process.platform}`);
  }
  if (process.arch !== "arm64") {
    fail(1, `Apple Foundation Model requires Apple Silicon. Current arch: ${process.arch}`);
  }
  // Darwin 25.x corresponds to macOS 26 Tahoe. Apple's FoundationModels
  // framework is only available from macOS 26 onwards.
  const major = parseInt(release().split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 25) {
    fail(
      1,
      `Apple Foundation Model requires macOS 26 (Tahoe) or later. Detected Darwin ${release()}.`,
    );
  }
  log(`host ok - darwin ${release()} arm64`);
}

function checkSwiftToolchain(): void {
  const res = spawnSync("swift", ["--version"], { stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) {
    fail(
      2,
      `Swift toolchain not found. Install Xcode Command Line Tools: xcode-select --install`,
    );
  }
  const firstLine = (res.stdout || "").split("\n")[0] || "swift";
  log(`swift toolchain: ${firstLine.trim()}`);
}

function checkSource(): void {
  if (!existsSync(BRIDGE_SOURCE_DIR)) {
    fail(3, `Bridge source not found at ${BRIDGE_SOURCE_DIR}`);
  }
  if (!existsSync(join(BRIDGE_SOURCE_DIR, "Package.swift"))) {
    fail(3, `Package.swift missing in ${BRIDGE_SOURCE_DIR}`);
  }
}

function buildBridge(): void {
  log(`building bridge in ${BRIDGE_SOURCE_DIR}`);
  const res = spawnSync("swift", ["build", "-c", "release"], {
    cwd: BRIDGE_SOURCE_DIR,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    fail(3, `swift build exited with status ${res.status}`);
  }
  if (!existsSync(BUILD_BINARY)) {
    fail(3, `build succeeded but artifact missing at ${BUILD_BINARY}`);
  }
  log(`build artifact: ${BUILD_BINARY}`);
}

function installBinary(): void {
  if (!existsSync(INSTALL_DIR)) {
    mkdirSync(INSTALL_DIR, { recursive: true });
  }
  try {
    copyFileSync(BUILD_BINARY, INSTALL_PATH);
    chmodSync(INSTALL_PATH, 0o755);
  } catch (err) {
    fail(4, `failed to install binary: ${(err as Error).message}`);
  }
  log(`installed to ${INSTALL_PATH}`);
}

function main(): void {
  log("Apple Foundation Model bridge installer");
  checkHost();
  checkSwiftToolchain();
  checkSource();
  buildBridge();
  installBinary();
  log("done. Provider `apple-foundation` is now available in 8gent-code.");
  log("Next: select it in the TUI provider switcher or set runtime in config.");
}

main();
