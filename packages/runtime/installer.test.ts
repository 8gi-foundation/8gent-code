/**
 * Tests for the installer surface (download + extract). Most paths are
 * tested with `dryRun: true` so we don't hit the network. The full
 * round-trip is gated on `RUNTIME_INTEGRATION=1` since it pulls a
 * ~30MB tarball from nodejs.org.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntime, planInstall } from "./installer.js";

describe("planInstall", () => {
	it("returns the URL + paths without touching the network", () => {
		const plan = planInstall({
			version: "22.12.0",
			root: "/tmp/fake-root",
			platform: "darwin",
			arch: "arm64",
		});
		expect(plan.url).toBe(
			"https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz",
		);
		expect(plan.runtimeDir).toContain("node-22.12.0");
		expect(plan.binPath).toContain("bin/node");
		expect(plan.archiveExt).toBe("tar.gz");
	});
	it("uses node.exe path on win32", () => {
		const plan = planInstall({
			version: "22.12.0",
			root: "/tmp/fake-root",
			platform: "win32",
			arch: "x64",
		});
		expect(plan.binPath.endsWith("node.exe")).toBe(true);
		expect(plan.archiveExt).toBe("zip");
	});
});

describe("installRuntime — dryRun", () => {
	let sandbox: string;
	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "8gent-runtime-installer-"));
	});
	afterEach(() => {
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("dryRun returns plan without downloading", async () => {
		const result = await installRuntime({
			version: "22.12.0",
			root: sandbox,
			platform: "darwin",
			arch: "arm64",
			dryRun: true,
		});
		expect(result.action).toBe("dry-run");
		expect(result.url).toContain("nodejs.org");
		expect(existsSync(result.runtimeDir)).toBe(false);
	});

	it("dryRun reports already-ready when binary exists", async () => {
		// Create a fake runtime that satisfies the version probe.
		const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
		const binDir = join(sandbox, "node-22.12.0", "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNode = join(binDir, "node");
		writeFileSync(fakeNode, "#!/bin/bash\necho 'v22.12.0'\n");
		chmodSync(fakeNode, 0o755);

		const result = await installRuntime({
			version: "22.12.0",
			root: sandbox,
			platform: "darwin",
			arch: "arm64",
			dryRun: true,
		});
		expect(result.action).toBe("already-ready");
	});
});

// Integration test — actually downloads from nodejs.org. Gated on
// RUNTIME_INTEGRATION=1 because it's slow and needs network. Skipped
// in CI by default.
const integrationGate = process.env.RUNTIME_INTEGRATION === "1";
describe.skipIf(!integrationGate)("installRuntime — integration", () => {
	let sandbox: string;
	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "8gent-runtime-int-"));
	});
	afterEach(() => {
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("downloads + extracts a real Node 22 build (slow)", async () => {
		const result = await installRuntime({
			version: "22.12.0",
			root: sandbox,
		});
		expect(result.action).toBe("installed");
		expect(existsSync(result.binPath)).toBe(true);
	}, 180_000); // 3-min budget for download + extract
});
