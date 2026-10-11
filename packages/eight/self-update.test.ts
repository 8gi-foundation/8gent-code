/**
 * #3981 (A2): `8gent update` must never install a lower version than the
 * one running, and must update from the channel it was installed from.
 * The regression: `8gent update` reinstalled from npm whatever version it
 * found there, even one lower than the version running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FetchLike,
	binaryAssetName,
	bundledChangelogPath,
	changelogBetween,
	compareVersions,
	decideUpdate,
	describeResult,
	detectChannel,
	latestBinaryRelease,
	npmInstallCommand,
	runSelfUpdate,
	sumFor,
} from "./self-update";

type Routes = Record<string, { status?: number; body: unknown }>;

function fakeFetch(routes: Routes): FetchLike & { calls: string[] } {
	const calls: string[] = [];
	const f = (async (url: string) => {
		calls.push(url);
		const r = routes[url];
		const status = r ? (r.status ?? 200) : 404;
		const body = r?.body;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
			arrayBuffer: async () => {
				const bytes =
					body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? ""));
				return bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer;
			},
		};
	}) as FetchLike & { calls: string[] };
	f.calls = calls;
	return f;
}

const NPM_URL = "https://registry.npmjs.org/@8gi-foundation%2f8gent-code";
const RELEASES = "https://example.test/releases";
const npmLatest = (v: string): Routes => ({ [NPM_URL]: { body: { "dist-tags": { latest: v } } } });

describe("versions", () => {
	test("compares numerically", () => {
		expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
		expect(compareVersions("v0.20.0", "0.20.0")).toBe(0);
		expect(compareVersions("0.17.0", "0.19.0")).toBe(-1);
		expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
	});
	test("rejects non X.Y.Z instead of guessing", () => {
		expect(() => compareVersions("0.20.0-rc.1", "0.19.0")).toThrow();
		expect(() => compareVersions("latest", "0.19.0")).toThrow();
	});
	test("lower is never an update", () => {
		expect(decideUpdate("0.19.0", "0.17.0").action).toBe("refuse-downgrade");
		expect(decideUpdate("0.19.0", "0.19.0").action).toBe("current");
		expect(decideUpdate("0.19.0", "0.20.0")).toEqual({
			action: "update",
			from: "0.19.0",
			to: "0.20.0",
		});
	});
});

describe("detectChannel", () => {
	test("compiled binary module paths", () => {
		expect(detectChannel({ modulePath: "/$bunfs/root/8gent" })).toBe("binary");
		expect(detectChannel({ modulePath: "B:/~BUN/root/8gent.exe" })).toBe("binary");
		expect(detectChannel({ modulePath: "/anything", embedded: true })).toBe("binary");
	});
	test("npm global install", () => {
		expect(
			detectChannel({
				modulePath: "/usr/local/lib/node_modules/@8gi-foundation/8gent-code/dist/cli.js",
				isGitCheckout: () => true,
			}),
		).toBe("npm");
		expect(
			detectChannel({
				modulePath:
					"C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@8gi-foundation\\8gent-code\\dist\\cli.js",
			}),
		).toBe("npm");
	});
	test("source checkout", () => {
		expect(
			detectChannel({
				modulePath: "file:///home/me/8gent-code/bin/8gent.ts",
				isGitCheckout: (d) => d === "/home/me/8gent-code",
			}),
		).toBe("source");
		expect(detectChannel({ modulePath: "/opt/8gent/cli.js", isGitCheckout: () => false })).toBe(
			"npm",
		);
	});
});

describe("npm channel", () => {
	test("the regression: an older version on the npm channel is refused, npm never runs", async () => {
		const runs: string[][] = [];
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "/usr/local/bin/node",
			fetchImpl: fakeFetch(npmLatest("0.17.0")),
			run: async (cmd, args) => {
				runs.push([cmd, ...args]);
				return 0;
			},
			log: () => {},
		});
		expect(r).toEqual({
			status: "refused-downgrade",
			from: "0.19.0",
			to: "0.17.0",
			channel: "npm",
		});
		expect(runs).toEqual([]);
		expect(describeResult(r)).toContain("never installs an older version");
	});

	test("installs the exact newer version, not @latest", async () => {
		const runs: { cmd: string; args: string[]; shell: boolean }[] = [];
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "x",
			platform: "linux",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			run: async (cmd, args, o) => {
				runs.push({ cmd, args, shell: o.shell });
				return 0;
			},
			log: () => {},
		});
		expect(r.status).toBe("updated");
		expect(runs).toEqual([
			{
				cmd: "npm",
				args: ["install", "-g", "@8gi-foundation/8gent-code@0.20.0", "--force"],
				shell: false,
			},
		]);
	});

	test("Windows runs npm.cmd through a shell", () => {
		expect(npmInstallCommand("0.20.0", "win32")).toEqual({
			cmd: "npm.cmd",
			args: ["install", "-g", "@8gi-foundation/8gent-code@0.20.0", "--force"],
			shell: true,
		});
	});

	test("equal version is up to date; npm failure is reported", async () => {
		const same = await runSelfUpdate({
			currentVersion: "0.20.0",
			channel: "npm",
			execPath: "x",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			run: async () => 0,
			log: () => {},
		});
		expect(same.status).toBe("current");
		const failed = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "x",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			run: async () => 1,
			log: () => {},
		});
		expect(failed.status).toBe("failed");
	});

	test("registry down is a failure, not a crash", async () => {
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "x",
			fetchImpl: fakeFetch({}),
			log: () => {},
		});
		expect(r.status).toBe("failed");
	});
});

describe("binary channel", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "self-update-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const asset = "8gent-linux-x64";
	const newBytes = new TextEncoder().encode("NEW-8GENT-0.20.0");
	const sum = createHash("sha256").update(newBytes).digest("hex");
	const release = (tag: string, withAssets = true) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: withAssets
			? [
					{ name: asset, browser_download_url: `https://dl.test/${tag}/${asset}` },
					{ name: "SHA256SUMS", browser_download_url: `https://dl.test/${tag}/SHA256SUMS` },
				]
			: [],
	});
	const routes = (sums = `${sum}  ${asset}\n`): Routes => ({
		[RELEASES]: {
			body: [
				release("v0.21.0", false),
				release("v0.20.0"),
				release("v0.9.0"),
				{ ...release("v0.30.0"), draft: true },
				release("desktop-v9.0.0"),
			],
		},
		[`https://dl.test/v0.20.0/${asset}`]: { body: newBytes },
		"https://dl.test/v0.20.0/SHA256SUMS": { body: sums },
	});

	test("picks the newest release that carries the binary", async () => {
		const rel = await latestBinaryRelease(fakeFetch(routes()), asset, RELEASES);
		expect(rel?.version).toBe("0.20.0");
	});

	test("asset names match build-binaries.ts", () => {
		expect(binaryAssetName("win32", "x64")).toBe("8gent-windows-x64.exe");
		expect(binaryAssetName("win32", "arm64")).toBe("8gent-windows-x64.exe");
		expect(binaryAssetName("darwin", "arm64")).toBe("8gent-darwin-arm64");
		expect(binaryAssetName("linux", "x64")).toBe("8gent-linux-x64");
		expect(binaryAssetName("freebsd", "x64")).toBeNull();
	});

	test("verifies, probes, then swaps the running binary", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "binary",
			execPath: exe,
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl: fakeFetch(routes()),
			probeVersion: async (f) =>
				readFileSync(f, "utf8").includes("0.20.0") ? "8gent Code v0.20.0\n" : "",
			log: () => {},
		});
		expect(r).toEqual({ status: "updated", from: "0.19.0", to: "0.20.0", channel: "binary" });
		expect(readFileSync(exe, "utf8")).toBe("NEW-8GENT-0.20.0");
		expect(existsSync(`${exe}.new`)).toBe(false);
	});

	test("Windows renames the running exe aside", async () => {
		const exe = join(dir, "8gent.exe");
		writeFileSync(exe, "OLD");
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "binary",
			execPath: exe,
			platform: "win32",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl: fakeFetch({
				[RELEASES]: {
					body: [
						{
							tag_name: "v0.20.0",
							assets: [
								{ name: "8gent-windows-x64.exe", browser_download_url: "https://dl.test/exe" },
								{ name: "SHA256SUMS", browser_download_url: "https://dl.test/sums" },
							],
						},
					],
				},
				"https://dl.test/exe": { body: newBytes },
				"https://dl.test/sums": { body: `${sum} *8gent-windows-x64.exe\n` },
			}),
			probeVersion: async () => "8gent Code v0.20.0",
			log: () => {},
		});
		expect(r.status).toBe("updated");
		expect(readFileSync(exe, "utf8")).toBe("NEW-8GENT-0.20.0");
		expect(readFileSync(`${exe}.old`, "utf8")).toBe("OLD");
	});

	test("checksum mismatch leaves the running binary untouched", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "binary",
			execPath: exe,
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl: fakeFetch(routes(`${"0".repeat(64)}  ${asset}\n`)),
			probeVersion: async () => "8gent Code v0.20.0",
			log: () => {},
		});
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("checksum mismatch");
		expect(readFileSync(exe, "utf8")).toBe("OLD");
		expect(existsSync(`${exe}.new`)).toBe(false);
	});

	test("a binary that reports the wrong version is not installed", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "binary",
			execPath: exe,
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl: fakeFetch(routes()),
			probeVersion: async () => "",
			log: () => {},
		});
		expect(r.status).toBe("failed");
		expect(readFileSync(exe, "utf8")).toBe("OLD");
		expect(existsSync(`${exe}.new`)).toBe(false);
	});

	test("a newer running binary is never replaced by an older release", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "DEV");
		const f = fakeFetch(routes());
		const r = await runSelfUpdate({
			currentVersion: "0.25.0",
			channel: "binary",
			execPath: exe,
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl: f,
			log: () => {},
		});
		expect(r.status).toBe("refused-downgrade");
		expect(readFileSync(exe, "utf8")).toBe("DEV");
		expect(f.calls).toEqual([RELEASES]);
	});
});

test("source checkouts are told to git pull, nothing runs", async () => {
	const r = await runSelfUpdate({
		currentVersion: "0.19.0",
		channel: "source",
		execPath: "x",
		fetchImpl: fakeFetch({}),
		log: () => {},
	});
	expect(r.status).toBe("source");
	expect(describeResult(r)).toContain("git pull");
});

test("sumFor reads both SHA256SUMS line styles", () => {
	const h = "a".repeat(64);
	expect(sumFor(`${h}  8gent-linux-x64\n`, "8gent-linux-x64")).toBe(h);
	expect(sumFor(`${h} *8gent-windows-x64.exe\r\n`, "8gent-windows-x64.exe")).toBe(h);
	expect(sumFor(`${h}  other\n`, "8gent-linux-x64")).toBeNull();
});

describe("changelog", () => {
	const md = [
		"# Changelog",
		"## [Unreleased]",
		"- not yet",
		"## [0.20.0] - 2026-10-12",
		"- steer mid-run",
		"## [0.19.0] - 2026-10-01",
		"- windows exe",
		"## [0.18.0] - 2026-10-01",
		"- old",
	].join("\n");
	test("sections between the old and the new version, newest first", () => {
		const s = changelogBetween(md, "0.18.0", "0.20.0");
		expect(s).toContain("steer mid-run");
		expect(s).toContain("windows exe");
		expect(s).not.toContain("old");
		expect(s).not.toContain("not yet");
		expect(s.indexOf("0.20.0")).toBeLessThan(s.indexOf("0.19.0"));
	});
	test("the npm package ships CHANGELOG.md and it is found from the package", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
		expect(pkg.files).toContain("CHANGELOG.md");
		expect(bundledChangelogPath(join(import.meta.dir, "..", "..", "dist"))).toBe(
			join(import.meta.dir, "..", "..", "CHANGELOG.md"),
		);
	});
});
