/**
 * scripts/install.sh against a fake release list served from file:// URLs.
 * The "binary" is a shell script that prints "8gent Code vX.Y.Z", which is
 * all the installer runs. Covers: newest release that carries this machine's
 * binary wins, empty releases are skipped, pinned versions, checksum
 * refusal, and never replacing a newer installed 8gent with an older one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "install.sh");

function hostAsset(): string {
	const os = spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim();
	let arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	arch = arch === "x86_64" || arch === "amd64" ? "x64" : "arm64";
	if (os === "Darwin" && arch === "x64") {
		const r = spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" });
		if (r.stdout.trim() === "1") arch = "arm64";
	}
	return `8gent-${os === "Darwin" ? "darwin" : "linux"}-${arch}`;
}

const ASSET = hostAsset();
const fakeBinary = (version: string) => `#!/bin/sh\necho "8gent Code v${version}"\n`;

let root: string;
let releasesDir: string;
let installDir: string;

interface FakeRelease {
	tag: string;
	/** asset name -> file contents */
	assets: Record<string, string>;
	/** write SHA256SUMS for these assets (default true) */
	sums?: boolean;
	/** corrupt the checksum of the binary */
	badSum?: boolean;
}

function writeReleases(releases: FakeRelease[]): string {
	const list = releases.map((r) => {
		const dir = join(releasesDir, "releases", "download", r.tag);
		mkdirSync(dir, { recursive: true });
		const names = Object.keys(r.assets);
		const lines: string[] = [];
		for (const name of names) {
			writeFileSync(join(dir, name), r.assets[name]);
			let sum = createHash("sha256").update(r.assets[name]).digest("hex");
			if (r.badSum && name === ASSET) sum = "0".repeat(64);
			lines.push(`${sum}  ${name}`);
		}
		const all = [...names];
		if (r.sums !== false) {
			writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
			all.push("SHA256SUMS");
		}
		return {
			tag_name: r.tag,
			draft: false,
			prerelease: false,
			assets: all.map((name) => ({
				name,
				browser_download_url: `file://${join(dir, name)}`,
			})),
		};
	});
	const file = join(releasesDir, "releases.json");
	writeFileSync(file, JSON.stringify(list, null, 2));
	return `file://${file}`;
}

function install(releasesUrl: string, env: Record<string, string> = {}) {
	const r = spawnSync("sh", [SCRIPT], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: root,
			TMPDIR: root,
			EIGHT_RELEASES_URL: releasesUrl,
			EIGHT_INSTALL_DIR: installDir,
			...env,
		},
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const installed = () => {
	const p = join(installDir, "8gent");
	if (!existsSync(p)) return null;
	return spawnSync(p, ["--version"], { encoding: "utf8" }).stdout.trim();
};

beforeEach(() => {
	const base = process.env.TMPDIR || tmpdir();
	root = mkdtempSync(join(base, "install-sh-"));
	releasesDir = join(root, "srv");
	installDir = join(root, "bin");
	mkdirSync(releasesDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install.sh", () => {
	test("installs the newest release that carries this machine's binary", () => {
		const url = writeReleases([
			// Newest tag, but published with no assets (v0.19.0 on 1 Oct).
			{ tag: "v0.21.0", assets: {} },
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0"), "other.tgz": "x" } },
			{ tag: "v0.9.0", assets: { [ASSET]: fakeBinary("0.9.0") } },
			// Not a release tag of the CLI.
			{ tag: "desktop-v9.0.0", assets: { [ASSET]: fakeBinary("9.0.0") } },
		]);
		const r = install(url);
		expect(r.out).toContain("Installed 8gent v0.20.0");
		expect(r.code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
	});

	test("compares versions numerically, not as text", () => {
		const url = writeReleases([
			{ tag: "v0.9.0", assets: { [ASSET]: fakeBinary("0.9.0") } },
			{ tag: "v0.10.0", assets: { [ASSET]: fakeBinary("0.10.0") } },
		]);
		expect(install(url).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.10.0");
	});

	test("EIGHT_VERSION pins a release, with or without the v", () => {
		const url = writeReleases([
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") } },
			{ tag: "v0.19.2", assets: { [ASSET]: fakeBinary("0.19.2") } },
		]);
		expect(install(url, { EIGHT_VERSION: "v0.19.2" }).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.19.2");
	});

	test("refuses a checksum mismatch and leaves nothing behind", () => {
		const url = writeReleases([
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") }, badSum: true },
		]);
		const r = install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("checksum mismatch");
		expect(installed()).toBeNull();
	});

	test("refuses a release without SHA256SUMS", () => {
		const url = writeReleases([
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") }, sums: false },
		]);
		const r = install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("unverified");
		expect(installed()).toBeNull();
	});

	test("refuses a binary that does not report the release's version", () => {
		const url = writeReleases([{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.19.0") } }]);
		const r = install(url);
		expect(r.code).not.toBe(0);
		expect(installed()).toBeNull();
	});

	test("never replaces a newer installed 8gent with an older release", () => {
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "8gent"), fakeBinary("0.30.0"));
		chmodSync(join(installDir, "8gent"), 0o755);
		const url = writeReleases([{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") } }]);
		const r = install(url);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Nothing changed");
		expect(installed()).toBe("8gent Code v0.30.0");
	});

	test("upgrades an older installed 8gent in place", () => {
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "8gent"), fakeBinary("0.17.0"));
		chmodSync(join(installDir, "8gent"), 0o755);
		const url = writeReleases([{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") } }]);
		expect(install(url).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
		expect(readFileSync(join(installDir, "8gent"), "utf8")).toContain("v0.20.0");
	});

	test("says so plainly when no release has a binary yet", () => {
		const url = writeReleases([{ tag: "v0.19.0", assets: {} }]);
		const r = install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(`no release carries a ${ASSET} binary`);
	});
});
