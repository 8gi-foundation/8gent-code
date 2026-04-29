/**
 * Tests for @8gent/runtime — managed Node 22 runtime.
 *
 * Strategy:
 * - Pure functions (version parsing, platform detection, URL builder)
 *   are tested directly with mocked inputs.
 * - File-system + spawn behaviour is tested against a temp directory
 *   (no real network downloads in CI; the integration test that
 *   actually fetches a tarball is gated on RUNTIME_INTEGRATION=1).
 *
 * Run:  bun test packages/runtime/
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDownloadUrl,
	getRuntimeDir,
	isRuntimeReady,
	parseNodeVersion,
	pickPlatformAsset,
	resolvedNodeBinPath,
	satisfiesMinVersion,
} from "./node-runtime.js";

// ---------------------------------------------------------------------------
// Pure parsing / version logic
// ---------------------------------------------------------------------------

describe("parseNodeVersion", () => {
	it("parses a normal `node --version` output", () => {
		expect(parseNodeVersion("v22.12.0\n")).toEqual({ major: 22, minor: 12, patch: 0 });
	});
	it("handles older format without leading v", () => {
		expect(parseNodeVersion("20.19.6")).toEqual({ major: 20, minor: 19, patch: 6 });
	});
	it("returns null on unparseable output", () => {
		expect(parseNodeVersion("not a version")).toBeNull();
		expect(parseNodeVersion("")).toBeNull();
	});
	it("trims whitespace + ignores trailing junk", () => {
		expect(parseNodeVersion("  v22.0.0 (some build info)\n")).toEqual({
			major: 22,
			minor: 0,
			patch: 0,
		});
	});
});

describe("satisfiesMinVersion", () => {
	it("accepts equal versions", () => {
		expect(satisfiesMinVersion({ major: 22, minor: 12, patch: 0 }, "22.12.0")).toBe(true);
	});
	it("accepts higher major", () => {
		expect(satisfiesMinVersion({ major: 24, minor: 0, patch: 0 }, "22.12.0")).toBe(true);
	});
	it("rejects lower major", () => {
		expect(satisfiesMinVersion({ major: 20, minor: 19, patch: 6 }, "22.12.0")).toBe(false);
	});
	it("rejects same major lower minor", () => {
		expect(satisfiesMinVersion({ major: 22, minor: 11, patch: 0 }, "22.12.0")).toBe(false);
	});
	it("rejects same major same minor lower patch", () => {
		expect(satisfiesMinVersion({ major: 22, minor: 12, patch: 0 }, "22.12.1")).toBe(false);
	});
	it("accepts higher patch", () => {
		expect(satisfiesMinVersion({ major: 22, minor: 12, patch: 5 }, "22.12.0")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Platform asset picker
// ---------------------------------------------------------------------------

describe("pickPlatformAsset", () => {
	it("picks darwin-arm64 for Apple Silicon", () => {
		expect(pickPlatformAsset({ platform: "darwin", arch: "arm64" })).toEqual({
			os: "darwin",
			arch: "arm64",
			ext: "tar.gz",
		});
	});
	it("picks darwin-x64 for Intel Mac", () => {
		expect(pickPlatformAsset({ platform: "darwin", arch: "x64" })).toEqual({
			os: "darwin",
			arch: "x64",
			ext: "tar.gz",
		});
	});
	it("picks linux-x64", () => {
		expect(pickPlatformAsset({ platform: "linux", arch: "x64" })).toEqual({
			os: "linux",
			arch: "x64",
			ext: "tar.xz",
		});
	});
	it("picks linux-arm64", () => {
		expect(pickPlatformAsset({ platform: "linux", arch: "arm64" })).toEqual({
			os: "linux",
			arch: "arm64",
			ext: "tar.xz",
		});
	});
	it("picks win-x64 zip", () => {
		expect(pickPlatformAsset({ platform: "win32", arch: "x64" })).toEqual({
			os: "win",
			arch: "x64",
			ext: "zip",
		});
	});
	it("throws for unsupported platform", () => {
		expect(() => pickPlatformAsset({ platform: "freebsd", arch: "x64" })).toThrow(
			/unsupported/i,
		);
	});
	it("throws for unsupported arch", () => {
		expect(() => pickPlatformAsset({ platform: "linux", arch: "ppc64" })).toThrow(
			/unsupported/i,
		);
	});
});

// ---------------------------------------------------------------------------
// Download URL builder
// ---------------------------------------------------------------------------

describe("buildDownloadUrl", () => {
	it("constructs an LTS URL for darwin-arm64", () => {
		const url = buildDownloadUrl({
			version: "22.12.0",
			asset: { os: "darwin", arch: "arm64", ext: "tar.gz" },
		});
		expect(url).toBe("https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz");
	});
	it("constructs a linux-x64 xz URL", () => {
		const url = buildDownloadUrl({
			version: "22.12.0",
			asset: { os: "linux", arch: "x64", ext: "tar.xz" },
		});
		expect(url).toBe("https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz");
	});
	it("strips a leading v from version input", () => {
		const url = buildDownloadUrl({
			version: "v22.12.0",
			asset: { os: "darwin", arch: "x64", ext: "tar.gz" },
		});
		expect(url).toContain("v22.12.0");
		expect(url).not.toContain("vv22");
	});
});

// ---------------------------------------------------------------------------
// Runtime path + readiness checks (filesystem-touching)
// ---------------------------------------------------------------------------

describe("getRuntimeDir + isRuntimeReady", () => {
	let sandbox: string;
	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "8gent-runtime-test-"));
	});
	afterEach(() => {
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("getRuntimeDir returns a stable path under the override root", () => {
		const dir = getRuntimeDir({ root: sandbox, version: "22.12.0" });
		expect(dir.startsWith(sandbox)).toBe(true);
		expect(dir).toContain("node-22.12.0");
	});

	it("resolvedNodeBinPath returns bin/node under the runtime dir on unix", () => {
		const bin = resolvedNodeBinPath({
			root: sandbox,
			version: "22.12.0",
			platform: "darwin",
		});
		expect(bin).toBe(join(sandbox, "node-22.12.0", "bin", "node"));
	});

	it("resolvedNodeBinPath returns node.exe at the root on win32", () => {
		const bin = resolvedNodeBinPath({
			root: sandbox,
			version: "22.12.0",
			platform: "win32",
		});
		expect(bin).toBe(join(sandbox, "node-22.12.0", "node.exe"));
	});

	it("isRuntimeReady returns false when the binary doesn't exist", async () => {
		const ready = await isRuntimeReady({
			root: sandbox,
			version: "22.12.0",
			platform: "darwin",
			minVersion: "22.12.0",
		});
		expect(ready).toBe(false);
	});

	it("isRuntimeReady returns true when a real-version-emitting binary is present", async () => {
		// Stand up a fake "node" shell script that prints a real version.
		const binDir = join(sandbox, "node-22.12.0", "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNode = join(binDir, "node");
		writeFileSync(fakeNode, "#!/bin/bash\necho 'v22.12.0'\n");
		chmodSync(fakeNode, 0o755);
		const ready = await isRuntimeReady({
			root: sandbox,
			version: "22.12.0",
			platform: "darwin",
			minVersion: "22.12.0",
		});
		expect(ready).toBe(true);
	});

	it("isRuntimeReady returns false when the binary reports a too-low version", async () => {
		const binDir = join(sandbox, "node-22.12.0", "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNode = join(binDir, "node");
		writeFileSync(fakeNode, "#!/bin/bash\necho 'v20.19.6'\n");
		chmodSync(fakeNode, 0o755);
		const ready = await isRuntimeReady({
			root: sandbox,
			version: "22.12.0",
			platform: "darwin",
			minVersion: "22.12.0",
		});
		expect(ready).toBe(false);
	});

	it("isRuntimeReady returns false when the binary errors on --version", async () => {
		const binDir = join(sandbox, "node-22.12.0", "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNode = join(binDir, "node");
		writeFileSync(fakeNode, "#!/bin/bash\nexit 1\n");
		chmodSync(fakeNode, 0o755);
		const ready = await isRuntimeReady({
			root: sandbox,
			version: "22.12.0",
			platform: "darwin",
			minVersion: "22.12.0",
		});
		expect(ready).toBe(false);
	});
});
