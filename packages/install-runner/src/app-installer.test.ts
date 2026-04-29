/**
 * Tests for the app installer. Uses a per-test temp dir for both the
 * registry DB and the apps dir so runs are hermetic.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-install-runner-"));
const APPS_DIR = path.join(TMP_ROOT, "apps");
const REGISTRY_DB = path.join(TMP_ROOT, "registry.db");

process.env.EIGHTGENT_DB = REGISTRY_DB;
process.env.EIGHTGENT_APPS_DIR = APPS_DIR;

const {
	disableApp,
	enableApp,
	getApp,
	InstallAppError,
	installApp,
	listApps,
	uninstallApp,
	updateApp,
} = await import("./app-installer.js");

afterAll(() => {
	fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

interface FixtureOpts {
	name?: string;
	version?: string;
	capabilities?: string[];
	includeManifest?: boolean;
	manifestOverride?: string;
	unsafePath?: string;
}

function buildFixture(label: string, opts: FixtureOpts = {}): string {
	const dir = fs.mkdtempSync(path.join(TMP_ROOT, `fix-${label}-`));
	const src = path.join(dir, "src");
	fs.mkdirSync(src, { recursive: true });
	if (opts.includeManifest !== false) {
		const manifest =
			opts.manifestOverride ??
			JSON.stringify({
				name: opts.name ?? "demo-app",
				version: opts.version ?? "1.0.0",
				entry: "main.js",
				capabilities: opts.capabilities ?? [],
				description: "test",
			});
		fs.writeFileSync(path.join(src, "app.json"), manifest);
	}
	fs.writeFileSync(path.join(src, "main.js"), 'console.log("hi")');

	const archive = path.join(dir, "app.tgz");
	const tarArgs = ["-czf", archive, "-C", src, "."];
	if (opts.unsafePath) {
		// Build a tar containing an extra entry whose path escapes via "../".
		const extraDir = fs.mkdtempSync(path.join(TMP_ROOT, "extra-"));
		fs.writeFileSync(path.join(extraDir, "evil"), "x");
		const list = path.join(dir, "list.txt");
		fs.writeFileSync(list, [".", "../escape"].join("\n"));
		// The simplest way to embed an unsafe path is via tar -T with explicit
		// transform. Easier path: write fixture by hand using node tar API.
		// For this test we cheat: build a normal archive and then append a
		// crafted member by re-tarring with --transform.
		spawnSync(
			"tar",
			["-czf", archive, "-C", src, `--transform=s,^./main.js,${opts.unsafePath},`, "."],
			{ stdio: "ignore" },
		);
	} else {
		spawnSync("tar", tarArgs, { stdio: "ignore" });
	}
	return archive;
}

describe("installApp — happy path (local archive)", () => {
	it("installs, registers, and exposes the app", async () => {
		const archive = buildFixture("happy", { name: "happy-app", version: "1.0.0" });

		const installed = await installApp(archive, { appsDir: APPS_DIR });

		expect(installed.name).toBe("happy-app");
		expect(installed.version).toBe("1.0.0");
		expect(installed.enabled).toBe(true);
		expect(fs.existsSync(installed.installPath)).toBe(true);
		expect(fs.existsSync(path.join(installed.installPath, "main.js"))).toBe(true);
		expect(fs.existsSync(path.join(installed.installPath, "app.json"))).toBe(true);

		const fetched = getApp("happy-app");
		expect(fetched).not.toBeNull();
		expect(fetched?.version).toBe("1.0.0");

		const all = listApps();
		expect(all.some((a) => a.name === "happy-app")).toBe(true);
	});
});

describe("integrity verification", () => {
	it("rejects archives with a mismatched sha256", async () => {
		const archive = buildFixture("integ", { name: "integ-app" });
		await expect(
			installApp(archive, { appsDir: APPS_DIR, sha256: "deadbeef".repeat(8) }),
		).rejects.toBeInstanceOf(InstallAppError);
		// no partial artifact
		expect(fs.existsSync(path.join(APPS_DIR, "integ-app"))).toBe(false);
	});
});

describe("URL allowlist", () => {
	it("rejects URLs not in the allowedHosts list", async () => {
		await expect(
			installApp("https://evil.example.com/app.tgz", {
				appsDir: APPS_DIR,
				allowedHosts: ["good.example.com"],
			}),
		).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
	});
});

describe("capability resolution", () => {
	it("rejects when required capability is unavailable", async () => {
		const archive = buildFixture("caps", {
			name: "caps-app",
			capabilities: ["fs:write", "net:fetch"],
		});
		await expect(
			installApp(archive, {
				appsDir: APPS_DIR,
				availableCapabilities: ["fs:write"],
			}),
		).rejects.toMatchObject({ code: "MISSING_CAPABILITIES" });
		expect(fs.existsSync(path.join(APPS_DIR, "caps-app"))).toBe(false);
	});

	it("succeeds when all required capabilities are available", async () => {
		const archive = buildFixture("caps-ok", {
			name: "caps-ok-app",
			capabilities: ["fs:write"],
		});
		const installed = await installApp(archive, {
			appsDir: APPS_DIR,
			availableCapabilities: ["fs:write", "net:fetch"],
		});
		expect(installed.name).toBe("caps-ok-app");
	});
});

describe("manifest validation", () => {
	it("rejects archives without app.json", async () => {
		const archive = buildFixture("no-manifest", { includeManifest: false });
		await expect(installApp(archive, { appsDir: APPS_DIR })).rejects.toMatchObject({
			code: "NO_MANIFEST",
		});
	});

	it("rejects manifests missing required fields", async () => {
		const archive = buildFixture("bad-manifest", {
			manifestOverride: JSON.stringify({ name: "x" }),
		});
		await expect(installApp(archive, { appsDir: APPS_DIR })).rejects.toMatchObject({
			code: "BAD_MANIFEST",
		});
	});
});

describe("lifecycle: enable / disable / uninstall / update", () => {
	it("toggles enabled state and persists across getApp calls", async () => {
		const archive = buildFixture("lifecycle", { name: "lifecycle-app" });
		await installApp(archive, { appsDir: APPS_DIR });

		const disabled = disableApp("lifecycle-app");
		expect(disabled.enabled).toBe(false);
		expect(getApp("lifecycle-app")?.enabled).toBe(false);

		const enabled = enableApp("lifecycle-app");
		expect(enabled.enabled).toBe(true);
		expect(getApp("lifecycle-app")?.enabled).toBe(true);
	});

	it("update replaces files and bumps version", async () => {
		const v1 = buildFixture("upd1", { name: "upd-app", version: "1.0.0" });
		await installApp(v1, { appsDir: APPS_DIR });
		const v2 = buildFixture("upd2", { name: "upd-app", version: "2.0.0" });
		const updated = await updateApp("upd-app", v2, { appsDir: APPS_DIR });
		expect(updated.version).toBe("2.0.0");
		expect(getApp("upd-app")?.version).toBe("2.0.0");
	});

	it("uninstall removes files and registry row", async () => {
		const archive = buildFixture("uninst", { name: "uninst-app" });
		const installed = await installApp(archive, { appsDir: APPS_DIR });
		await uninstallApp("uninst-app");
		expect(fs.existsSync(installed.installPath)).toBe(false);
		expect(getApp("uninst-app")).toBeNull();
	});
});

describe("rollback", () => {
	it("leaves no partial artifacts when manifest is invalid", async () => {
		const archive = buildFixture("rollback", { includeManifest: false });
		await expect(installApp(archive, { appsDir: APPS_DIR })).rejects.toBeInstanceOf(
			InstallAppError,
		);
		const stagingDir = path.join(APPS_DIR, ".staging");
		const leftover = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
		expect(leftover.length).toBe(0);
	});
});
