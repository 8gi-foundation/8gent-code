/**
 * #3981 (A2): `8gent update` must never install a lower version than the
 * one running, and must update from the channel it was installed from.
 * The regression: `8gent update` reinstalled from npm whatever version it
 * found there, even one lower than the version running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpdate, describeCheck, runUpdateCommand } from "./cli-maintenance";
import {
	type FetchLike,
	PROBE_TIMEOUT_MS,
	RELEASE_SIGNING_KEY,
	binaryAssetName,
	binaryAssetNames,
	bundledChangelogPath,
	changelogBetween,
	compareVersions,
	decideUpdate,
	describeResult,
	detectChannel,
	hopAllowed,
	latestBinaryRelease,
	latestForNpmChannel,
	latestReleaseFromRedirect,
	npmInstallCommand,
	npmPrefixFromModulePath,
	npmTarballName,
	probeVersionWithTimeout,
	runSelfUpdate,
	sumFor,
	urlAllowed,
	verifyMinisign,
} from "./self-update";

type Routes = Record<string, { status?: number; body: unknown; location?: string }>;
type Init = Parameters<FetchLike>[1];

function fakeFetch(routes: Routes): FetchLike & { calls: string[]; inits: Init[] } {
	const calls: string[] = [];
	const inits: Init[] = [];
	const f = (async (url: string, init?: Init) => {
		calls.push(url);
		inits.push(init);
		const r = routes[url];
		const status = r ? (r.status ?? 200) : 404;
		const body = r?.body;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: {
				get: (n: string) => (n.toLowerCase() === "location" ? (r?.location ?? null) : null),
			},
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
	}) as FetchLike & { calls: string[]; inits: Init[] };
	f.calls = calls;
	f.inits = inits;
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
				args: ["install", "-g", "@8gi-foundation/8gent-code@0.20.0"],
				shell: false,
			},
		]);
	});

	test("Windows runs npm.cmd through a shell", () => {
		expect(npmInstallCommand("0.20.0", "win32")).toEqual({
			cmd: "npm.cmd",
			args: ["install", "-g", "@8gi-foundation/8gent-code@0.20.0"],
			shell: true,
		});
	});

	// #4188, 13 Oct: James's 8gent lives under /opt/homebrew, the npm npm picked
	// defaulted to /usr/local, and `8gent update` failed EACCES there.
	test("the global prefix comes from where this 8gent is installed", () => {
		const brew = "/opt/homebrew/lib/node_modules/@8gi-foundation/8gent-code/bin/8gent-run.js";
		expect(npmPrefixFromModulePath(brew, "darwin")).toBe("/opt/homebrew");
		expect(npmPrefixFromModulePath(`file://${brew}`, "darwin")).toBe("/opt/homebrew");
		expect(
			npmPrefixFromModulePath(
				"/usr/local/lib/node_modules/@8gi-foundation/8gent-code/dist/cli.js",
				"linux",
			),
		).toBe("/usr/local");
		expect(
			npmPrefixFromModulePath(
				"C:\\Users\\A B\\AppData\\Roaming\\npm\\node_modules\\@8gi-foundation\\8gent-code\\dist\\cli.js",
				"win32",
			),
		).toBe("C:\\Users\\A B\\AppData\\Roaming\\npm");
		// A project-local node_modules or a checkout is not an npm global install.
		expect(
			npmPrefixFromModulePath(
				"/work/app/node_modules/@8gi-foundation/8gent-code/dist/cli.js",
				"linux",
			),
		).toBeNull();
		expect(npmPrefixFromModulePath("/home/a/8gent-code/bin/8gent.ts", "linux")).toBeNull();
	});

	test("installs into the running 8gent's prefix; --force only on the retry", async () => {
		const runs: string[][] = [];
		const codes = [1, 0];
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "x",
			platform: "darwin",
			npmPrefix: "/opt/homebrew",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			run: async (_cmd, args) => {
				runs.push(args);
				return codes.shift() ?? 0;
			},
			log: () => {},
		});
		expect(r.status).toBe("updated");
		expect(runs).toEqual([
			["install", "-g", "@8gi-foundation/8gent-code@0.20.0", "--prefix", "/opt/homebrew"],
			[
				"install",
				"-g",
				"@8gi-foundation/8gent-code@0.20.0",
				"--prefix",
				"/opt/homebrew",
				"--force",
			],
		]);
	});

	test("8gent update on a Homebrew npm install passes /opt/homebrew to npm", async () => {
		const ran: string[][] = [];
		const code = await runUpdateCommand([], {
			currentVersion: "0.19.0",
			modulePath: "/opt/homebrew/lib/node_modules/@8gi-foundation/8gent-code/bin/8gent-run.js",
			embedded: false,
			execPath: "/opt/homebrew/bin/node",
			platform: "darwin",
			arch: "arm64",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			env: { EIGHT_RELEASES_URL: RELEASES },
			interactive: true,
			log: () => {},
			run: async (_cmd, args) => {
				ran.push(args);
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(ran).toEqual([
			["install", "-g", "@8gi-foundation/8gent-code@0.20.0", "--prefix", "/opt/homebrew"],
		]);
	});

	test("both attempts failing names the prefix in the hint", async () => {
		const r = await runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "npm",
			execPath: "x",
			platform: "darwin",
			npmPrefix: "/opt/homebrew",
			fetchImpl: fakeFetch(npmLatest("0.20.0")),
			run: async () => 243,
			log: () => {},
		});
		expect(describeResult(r)).toBe(
			"Update failed: npm exited 243. Try: npm install -g @8gi-foundation/8gent-code@0.20.0 --prefix /opt/homebrew --force",
		);
	});

	test("Windows quotes the prefix for the npm.cmd shell", () => {
		expect(
			npmInstallCommand("0.20.0", "win32", undefined, { prefix: "C:\\A B\\npm" }).args,
		).toEqual(["install", "-g", "@8gi-foundation/8gent-code@0.20.0", "--prefix", '"C:\\A B\\npm"']);
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

describe("npm channel from the GitHub release (#3658)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "self-update-npm-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const DL = "https://github.com/8gi-foundation/8gent-code/releases/download";
	const tgz = npmTarballName("0.20.0");
	const tgzBytes = new TextEncoder().encode("NPM-TARBALL-0.20.0");
	const tgzSum = createHash("sha256").update(tgzBytes).digest("hex");
	const rel = (tag: string, names: string[]) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: names.map((name) => ({ name, browser_download_url: `${DL}/${tag}/${name}` })),
	});
	// The real state on 13 Oct 2026: npm latest 0.17.0, v0.19.0 public with no
	// assets, and (once the release PR merges) v0.20.0 with the tarball.
	const routes = (npm: Routes, sums = `${tgzSum}  ${tgz}\n`): Routes => ({
		...npm,
		[RELEASES]: {
			body: [
				rel("v0.20.0", [tgz, "SHA256SUMS"]),
				rel("v0.19.0", []),
				rel("v2.1.0", []),
				rel("desktop-v0.1.0", ["8gent-linux-x64"]),
			],
		},
		[`${DL}/v0.20.0/${tgz}`]: { body: tgzBytes },
		[`${DL}/v0.20.0/SHA256SUMS`]: { body: sums },
	});
	const update = (
		fetchImpl: FetchLike,
		runs: { args: string[]; staged: string }[],
		extra: Partial<Parameters<typeof runSelfUpdate>[0]> = {},
	) =>
		runSelfUpdate({
			currentVersion: "0.18.0",
			channel: "npm",
			execPath: "x",
			platform: "linux",
			releasesUrl: RELEASES,
			fetchImpl,
			tmpDir: dir,
			signingKey: "",
			run: async (_cmd, args) => {
				const file = args[2];
				runs.push({ args, staged: file.startsWith("/") ? readFileSync(file, "utf8") : "" });
				return 0;
			},
			log: () => {},
			...extra,
		});

	test("tarball name is npm pack's, as release.yml attaches it", () => {
		expect(npmTarballName("0.18.0")).toBe("8gi-foundation-8gent-code-0.18.0.tgz");
	});

	test("the regression: npm stuck at 0.17.0 no longer hides a newer release", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(fakeFetch(routes(npmLatest("0.17.0"))), runs);
		expect(r).toEqual({ status: "updated", from: "0.18.0", to: "0.20.0", channel: "npm" });
		expect(runs).toHaveLength(1);
		expect(runs[0].args[0]).toBe("install");
		expect(runs[0].args[1]).toBe("-g");
		expect(runs[0].args[2].endsWith(`/${tgz}`)).toBe(true);
		expect(runs[0].args[3]).toBe("--ignore-scripts");
		expect(runs[0].args).toHaveLength(4);
		// npm installed exactly the verified bytes, and nothing is left behind.
		expect(runs[0].staged).toBe("NPM-TARBALL-0.20.0");
		expect(readdirSync(dir)).toEqual([]);
	});

	test("the release package wins even when npm is as new: the registry is not asked (#4698)", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const f = fakeFetch(routes(npmLatest("0.20.0")));
		const r = await update(f, runs);
		expect(r.status).toBe("updated");
		expect(runs[0].args.slice(3)).toEqual(["--ignore-scripts"]);
		expect(runs[0].staged).toBe("NPM-TARBALL-0.20.0");
		expect(f.calls).not.toContain(NPM_URL);
	});

	test("npm ahead of the newest GitHub release is reported with the exact npm command, never 'up to date'", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(fakeFetch(routes(npmLatest("0.20.1"))), runs, {
			currentVersion: "0.20.0",
		});
		expect(runs).toEqual([]);
		expect(r.status).toBe("failed");
		const msg = r.status === "failed" ? r.message : "";
		expect(msg).toContain("npm has 0.20.1");
		expect(msg).toContain("npm install -g @8gi-foundation/8gent-code@0.20.1");
	});

	test("an unreachable registry is no claim: current stays current", async () => {
		const r = await update(fakeFetch(routes({})), [], { currentVersion: "0.20.0" });
		expect(r.status).toBe("current");
	});

	test("a checksum mismatch refuses the tarball and npm never runs", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(
			fakeFetch(routes(npmLatest("0.17.0"), `${"0".repeat(64)}  ${tgz}\n`)),
			runs,
		);
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("checksum mismatch");
		expect(runs).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("SHA256SUMS that does not list the tarball is refused", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(fakeFetch(routes(npmLatest("0.17.0"), "abc  other\n")), runs);
		expect(r.status).toBe("failed");
		expect(runs).toEqual([]);
	});

	test("registry down: the release still serves the npm channel", async () => {
		const target = await latestForNpmChannel(fakeFetch(routes({})), RELEASES);
		expect(target.version).toBe("0.20.0");
		expect(target.release?.asset).toBe(tgz);
	});

	test("GitHub down: npm alone decides, as before", async () => {
		const target = await latestForNpmChannel(fakeFetch(npmLatest("0.17.0")), RELEASES);
		expect(target).toEqual({ version: "0.17.0", release: null, source: "npm" });
	});

	test("both down is a failure, not a crash", async () => {
		await expect(latestForNpmChannel(fakeFetch({}), RELEASES)).rejects.toThrow(
			"GitHub releases answered 404",
		);
		await expect(latestForNpmChannel(fakeFetch({}), RELEASES)).rejects.toThrow(
			"npm registry answered 404",
		);
	});

	test("a release without the tarball is ignored, so a lower npm is still refused", async () => {
		const f = fakeFetch({
			...npmLatest("0.17.0"),
			[RELEASES]: { body: [rel("v0.19.0", [])] },
		});
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(f, runs);
		expect(r).toEqual({
			status: "refused-downgrade",
			from: "0.18.0",
			to: "0.17.0",
			channel: "npm",
		});
		expect(runs).toEqual([]);
	});

	test("GitHub API and the latest redirect both refused: npm alone decides, a lower npm is refused", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const f = fakeFetch({
			...npmLatest("0.17.0"),
			[RELEASES]: { status: 403, body: {} },
			[LATEST]: { status: 429, body: "" },
		});
		const r = await update(f, runs);
		expect(r.status).toBe("refused-downgrade");
		expect(runs).toEqual([]);
		expect(f.inits.every((i) => !i?.headers?.authorization)).toBe(true);
	});

	test("a release key with no SHA256SUMS.minisig refuses the tarball; npm never runs", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const r = await update(fakeFetch(routes(npmLatest("0.17.0"))), runs, {
			signingKey: "RWQBI0VniavN7xxx",
		});
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("refusing unsigned checksums");
		expect(runs).toEqual([]);
	});

	test("a tarball URL that climbs out of the repo's releases is refused; npm never runs", async () => {
		const runs: { args: string[]; staged: string }[] = [];
		const evil = `${DL}/../../../../evil/repo/releases/download/v0.20.0/${tgz}`;
		const r = await update(
			fakeFetch({
				...npmLatest("0.17.0"),
				[RELEASES]: {
					body: [
						{
							tag_name: "v0.20.0",
							draft: false,
							prerelease: false,
							assets: [
								{ name: tgz, browser_download_url: evil },
								{ name: "SHA256SUMS", browser_download_url: `${DL}/v0.20.0/SHA256SUMS` },
							],
						},
					],
				},
				[`${DL}/v0.20.0/SHA256SUMS`]: { body: `${tgzSum}  ${tgz}\n` },
				[`https://github.com/evil/repo/releases/download/v0.20.0/${tgz}`]: { body: tgzBytes },
				[evil]: { body: tgzBytes },
			}),
			runs,
		);
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("refusing");
		expect(runs).toEqual([]);
	});

	test("--check on the npm channel reports the release npm does not have yet", async () => {
		const r = await checkUpdate({
			currentVersion: "0.18.0",
			channel: "npm",
			fetchImpl: fakeFetch(routes(npmLatest("0.17.0"))),
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
		});
		expect(describeCheck(r)).toBe(
			"v0.20.0 is available (this is v0.18.0, npm channel). Run: 8gent update",
		);
	});

	test("Windows quotes the staged tarball path for the npm.cmd shell", () => {
		expect(npmInstallCommand("0.20.0", "win32", "C:\\Users\\A B\\x.tgz").args[2]).toBe(
			'"C:\\Users\\A B\\x.tgz"',
		);
		expect(npmInstallCommand("0.20.0", "linux", "/tmp/x.tgz").args[2]).toBe("/tmp/x.tgz");
	});
});

// #4698, 21 Oct 2026: Termux installs the release npm package; api.github.com
// answered 403 to anonymous calls that day, and npm latest was still 0.17.0.
const LATEST = "https://github.com/8gi-foundation/8gent-code/releases/latest";
const TAG_URL = "https://github.com/8gi-foundation/8gent-code/releases/tag";
const DLR = "https://github.com/8gi-foundation/8gent-code/releases/download";

describe("release found without api.github.com (#4698)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "self-update-redirect-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const tgz = npmTarballName("0.20.10");
	const bytes = new TextEncoder().encode("NPM-TARBALL-0.20.10");
	const sum = createHash("sha256").update(bytes).digest("hex");
	const API = "https://api.github.com/repos/8gi-foundation/8gent-code/releases?per_page=100";
	const PREFIX = "/data/data/com.termux/files/usr";
	// The real Termux shape: API 403, redirect to the tag, assets on github.com.
	const termux = (o: { sums?: string; location?: string; npm?: Routes } = {}): Routes => ({
		...(o.npm ?? npmLatest("0.17.0")),
		[API]: { status: 403, body: { message: "API rate limit exceeded" } },
		[LATEST]: { status: 302, body: "", location: o.location ?? `${TAG_URL}/v0.20.10` },
		[`${DLR}/v0.20.10/${tgz}`]: {
			status: 302,
			body: "",
			location: "https://release-assets.githubusercontent.com/x/tgz",
		},
		"https://release-assets.githubusercontent.com/x/tgz": { body: bytes },
		[`${DLR}/v0.20.10/SHA256SUMS`]: { body: o.sums ?? `${sum}  ${tgz}\n` },
	});
	const termuxUpdate = async (
		f: FetchLike,
		currentVersion = "0.20.4",
	): Promise<{
		code: number;
		lines: string[];
		runs: { cmd: string; args: string[]; staged: string }[];
	}> => {
		const lines: string[] = [];
		const runs: { cmd: string; args: string[]; staged: string }[] = [];
		const code = await runUpdateCommand([], {
			currentVersion,
			modulePath: `file://${PREFIX}/lib/node_modules/@8gi-foundation/8gent-code/bin/8gent.ts`,
			embedded: false,
			execPath: `${PREFIX}/bin/node`,
			platform: "android",
			arch: "arm64",
			fetchImpl: f,
			env: { PREFIX, TERMUX_VERSION: "0.118.1" },
			interactive: true,
			log: (l) => lines.push(l),
			selfUpdate: (o) => runSelfUpdate({ ...o, tmpDir: dir, signingKey: "" }),
			run: async (cmd, args) => {
				const file = args[2];
				runs.push({ cmd, args, staged: file.startsWith("/") ? readFileSync(file, "utf8") : "" });
				return 0;
			},
		});
		return { code, lines, runs };
	};

	test("Termux: API 403 falls back to the redirect; the verified tgz installs with --ignore-scripts", async () => {
		const f = fakeFetch(termux());
		const { code, lines, runs } = await termuxUpdate(f);
		expect(code).toBe(0);
		expect(runs).toHaveLength(1);
		expect(runs[0].cmd).toBe("npm");
		const [install, g, file, ...rest] = runs[0].args;
		expect([install, g]).toEqual(["install", "-g"]);
		expect(file.startsWith(`${dir}/8gent-update-`)).toBe(true);
		expect(file.endsWith(`/${tgz}`)).toBe(true);
		expect(rest).toEqual(["--ignore-scripts", "--prefix", PREFIX]);
		expect(runs[0].staged).toBe("NPM-TARBALL-0.20.10");
		// The stale registry is never asked, and the private temp dir is gone.
		expect(f.calls).not.toContain(NPM_URL);
		expect(readdirSync(dir)).toEqual([]);
		const text = lines.join("\n");
		expect(lines[0]).toBe(
			"8gent v0.20.4, installed with npm (updates from the GitHub release package).",
		);
		expect(text).toContain("Latest version: v0.20.10 (GitHub release, found through github.com");
		expect(text).toContain(`SHA256 matches SHA256SUMS: ${sum}`);
		expect(text).toContain("Updated 8gent v0.20.4 -> v0.20.10.");
	});

	test("a checksum mismatch aborts before npm runs", async () => {
		const { code, lines, runs } = await termuxUpdate(
			fakeFetch(termux({ sums: `${"0".repeat(64)}  ${tgz}\n` })),
		);
		expect(code).toBe(1);
		expect(runs).toEqual([]);
		expect(lines.join("\n")).toContain("checksum mismatch");
		expect(readdirSync(dir)).toEqual([]);
	});

	test("up to date is a no-op: nothing downloaded, npm never runs", async () => {
		const f = fakeFetch(termux());
		const { code, lines, runs } = await termuxUpdate(f, "0.20.10");
		expect(code).toBe(0);
		expect(runs).toEqual([]);
		expect(f.calls.some((u) => u.includes("/releases/download/"))).toBe(false);
		expect(lines.slice(-2)).toEqual([
			"Already up to date.",
			"8gent v0.20.10 is the newest release.",
		]);
	});

	for (const [label, location] of [
		["a prerelease suffix", `${TAG_URL}/v0.20.11-rc.1`],
		["a non-version tag", `${TAG_URL}/desktop-v0.1.0`],
		["an encoded path climb", `${TAG_URL}/..%2F..%2Fevil`],
		["another host", "https://evil.example/8gi-foundation/8gent-code/releases/tag/v9.9.9"],
		["another repo", "https://github.com/evil/repo/releases/tag/v9.9.9"],
		["plain http", "http://github.com/8gi-foundation/8gent-code/releases/tag/v9.9.9"],
	] as const) {
		test(`a redirect to ${label} is rejected; nothing installs`, async () => {
			await expect(
				latestReleaseFromRedirect(fakeFetch(termux({ location })), npmTarballName),
			).rejects.toThrow("refusing");
			const { code, runs } = await termuxUpdate(fakeFetch(termux({ location, npm: {} })));
			expect(code).toBe(1);
			expect(runs).toEqual([]);
		});
	}

	test("the redirect builds asset URLs only under the repo's releases/download/<tag>/", async () => {
		const rel = await latestReleaseFromRedirect(fakeFetch(termux()), npmTarballName);
		expect(rel.version).toBe("0.20.10");
		expect(rel.asset).toBe(tgz);
		for (const u of Object.values(rel.urls)) {
			expect(u.startsWith(`${DLR}/v0.20.10/`)).toBe(true);
			expect(urlAllowed(u, "asset")).toBe(true);
		}
	});

	test("a 200 from releases/latest (no redirect) is an error, not a guess", async () => {
		await expect(
			latestReleaseFromRedirect(fakeFetch({ [LATEST]: { body: "<html>" } }), npmTarballName),
		).rejects.toThrow("not a redirect");
	});

	test("--check on Termux reports the release through the redirect", async () => {
		const r = await checkUpdate({
			currentVersion: "0.20.4",
			channel: "npm",
			fetchImpl: fakeFetch(termux()),
			platform: "android",
			arch: "arm64",
		});
		expect(describeCheck(r)).toBe(
			"v0.20.10 is available (this is v0.20.4, npm channel). Run: 8gent update",
		);
	});
});

describe("binary channel", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "self-update-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const asset = "8gent-linux-x64";
	const DL = "https://github.com/8gi-foundation/8gent-code/releases/download";
	const newBytes = new TextEncoder().encode("NEW-8GENT-0.20.0");
	const sum = createHash("sha256").update(newBytes).digest("hex");
	const release = (tag: string, withAssets = true, extra: string[] = []) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: withAssets
			? [asset, "SHA256SUMS", ...extra].map((name) => ({
					name,
					browser_download_url: `${DL}/${tag}/${name}`,
				}))
			: [],
	});
	const routes = (sums = `${sum}  ${asset}\n`): Routes => ({
		[RELEASES]: {
			body: [
				release("v0.21.0", false),
				release("v0.20.0"),
				release("v0.9.0"),
				{ ...release("v0.30.0"), draft: true },
				{ ...release("v0.31.0"), prerelease: true },
				release("desktop-v9.0.0"),
			],
		},
		[`${DL}/v0.20.0/${asset}`]: { body: newBytes },
		[`${DL}/v0.20.0/SHA256SUMS`]: { body: sums },
	});
	const base = (
		exe: string,
		fetchImpl: FetchLike,
		extra: Partial<Parameters<typeof runSelfUpdate>[0]> = {},
	) =>
		runSelfUpdate({
			currentVersion: "0.19.0",
			channel: "binary",
			execPath: exe,
			platform: "linux",
			arch: "x64",
			releasesUrl: RELEASES,
			fetchImpl,
			probeVersion: async (f) =>
				readFileSync(f, "utf8").includes("0.20.0") ? "8gent Code v0.20.0\n" : "",
			log: () => {},
			signingKey: "",
			...extra,
		});
	const leftovers = () => readdirSync(dir).filter((n) => n.endsWith(".new"));

	test("binary channel: npm ahead of the newest release says so instead of 'up to date'", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const f = fakeFetch({ ...routes(), ...npmLatest("0.20.1") });
		const r = await base(exe, f, { currentVersion: "0.20.0" });
		expect(r.status).toBe("failed");
		const msg = r.status === "failed" ? r.message : "";
		expect(msg).toContain("npm has 0.20.1");
		expect(msg).toContain("npm install -g @8gi-foundation/8gent-code@0.20.1");
		expect(readFileSync(exe, "utf8")).toBe("OLD");
	});

	test("picks the newest published, non-prerelease release that carries the binary", async () => {
		const rel = await latestBinaryRelease(fakeFetch(routes()), asset, RELEASES);
		expect(rel?.version).toBe("0.20.0");
	});

	test("asset names match build-binaries.ts; Windows falls back to baseline", () => {
		expect(binaryAssetNames("win32", "x64")).toEqual([
			"8gent-windows-x64.exe",
			"8gent-windows-x64-baseline.exe",
		]);
		expect(binaryAssetName("win32", "arm64")).toBe("8gent-windows-x64.exe");
		expect(binaryAssetName("darwin", "arm64")).toBe("8gent-darwin-arm64");
		expect(binaryAssetName("linux", "x64")).toBe("8gent-linux-x64");
		expect(binaryAssetName("freebsd", "x64")).toBeNull();
	});

	test("verifies, probes, then swaps the running binary, leaving no staging file", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await base(exe, fakeFetch(routes()));
		expect(r).toEqual({ status: "updated", from: "0.19.0", to: "0.20.0", channel: "binary" });
		expect(readFileSync(exe, "utf8")).toBe("NEW-8GENT-0.20.0");
		expect(leftovers()).toEqual([]);
	});

	test("Windows renames the running exe aside, then tries baseline when x64 will not start", async () => {
		const exe = join(dir, "8gent.exe");
		writeFileSync(exe, "OLD");
		const x64 = new TextEncoder().encode("X64-NEEDS-AVX2");
		const baseline = new TextEncoder().encode("BASELINE-0.20.0");
		const h = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
		const names = ["8gent-windows-x64.exe", "8gent-windows-x64-baseline.exe", "SHA256SUMS"];
		const r = await base(
			exe,
			fakeFetch({
				[RELEASES]: {
					body: [
						{
							tag_name: "v0.20.0",
							assets: names.map((name) => ({
								name,
								browser_download_url: `${DL}/v0.20.0/${name}`,
							})),
						},
					],
				},
				[`${DL}/v0.20.0/8gent-windows-x64.exe`]: { body: x64 },
				[`${DL}/v0.20.0/8gent-windows-x64-baseline.exe`]: { body: baseline },
				[`${DL}/v0.20.0/SHA256SUMS`]: {
					body: `${h(x64)} *8gent-windows-x64.exe\n${h(baseline)} *8gent-windows-x64-baseline.exe\n`,
				},
			}),
			{ platform: "win32" },
		);
		expect(r.status).toBe("updated");
		expect(readFileSync(exe, "utf8")).toBe("BASELINE-0.20.0");
		expect(readFileSync(`${exe}.old`, "utf8")).toBe("OLD");
		expect(leftovers()).toEqual([]);
	});

	test("checksum mismatch leaves the running binary untouched", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await base(exe, fakeFetch(routes(`${"0".repeat(64)}  ${asset}\n`)));
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("checksum mismatch");
		expect(readFileSync(exe, "utf8")).toBe("OLD");
		expect(leftovers()).toEqual([]);
	});

	test("a binary that reports the wrong version is not installed", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const r = await base(exe, fakeFetch(routes()), { probeVersion: async () => "" });
		expect(r.status).toBe("failed");
		expect(readFileSync(exe, "utf8")).toBe("OLD");
		expect(leftovers()).toEqual([]);
	});

	test("a newer running binary is never replaced by an older release", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "DEV");
		const f = fakeFetch(routes());
		const r = await base(exe, f, { currentVersion: "0.25.0" });
		expect(r.status).toBe("refused-downgrade");
		expect(readFileSync(exe, "utf8")).toBe("DEV");
		expect(f.calls).toEqual([RELEASES]);
	});

	test("an asset URL outside the repository's releases is refused", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const evil = "https://evil.test/8gent-linux-x64";
		const f = fakeFetch({
			[RELEASES]: {
				body: [
					{
						tag_name: "v0.20.0",
						assets: [
							{ name: asset, browser_download_url: evil },
							{ name: "SHA256SUMS", browser_download_url: `${DL}/v0.20.0/SHA256SUMS` },
						],
					},
				],
			},
			[`${DL}/v0.20.0/SHA256SUMS`]: { body: `${sum}  ${asset}\n` },
			[evil]: { body: newBytes },
		});
		const r = await base(exe, f);
		expect(r.status).toBe("failed");
		expect(describeResult(r)).toContain("refusing");
		expect(f.calls).not.toContain(evil);
		expect(readFileSync(exe, "utf8")).toBe("OLD");
	});

	test("redirects are followed by hand: GitHub download hosts only, https only", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const blob = "https://release-assets.githubusercontent.com/blob/1";
		const ok = routes();
		ok[`${DL}/v0.20.0/${asset}`] = { status: 302, location: blob, body: "" };
		ok[blob] = { body: newBytes };
		expect((await base(exe, fakeFetch(ok))).status).toBe("updated");

		for (const bad of ["https://evil.test/blob", "http://objects.githubusercontent.com/blob"]) {
			writeFileSync(exe, "OLD");
			const r = routes();
			r[`${DL}/v0.20.0/${asset}`] = { status: 302, location: bad, body: "" };
			r[bad] = { body: newBytes };
			const f = fakeFetch(r);
			const res = await base(exe, f);
			expect(res.status).toBe("failed");
			expect(describeResult(res)).toContain("refusing a redirect");
			expect(f.calls).not.toContain(bad);
			expect(readFileSync(exe, "utf8")).toBe("OLD");
		}
	});

	test("every request asks fetch not to follow redirects itself", async () => {
		const exe = join(dir, "8gent");
		writeFileSync(exe, "OLD");
		const f = fakeFetch(routes());
		await base(exe, f);
		expect(f.inits.every((i) => i?.redirect === "manual")).toBe(true);
	});

	describe("signed SHA256SUMS", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const keyId = Buffer.from("0123456789abcdef", "hex");
		const rawPk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
		const pub = Buffer.concat([Buffer.from("Ed"), keyId, rawPk]).toString("base64");
		function minisig(
			message: Uint8Array,
			comment = "timestamp:1 file:SHA256SUMS",
			id = keyId,
		): string {
			const hashed = createHash("blake2b512").update(message).digest();
			const sig = cryptoSign(null, hashed, privateKey);
			const global = cryptoSign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
			return [
				"untrusted comment: signature from minisign secret key",
				Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64"),
				`trusted comment: ${comment}`,
				global.toString("base64"),
				"",
			].join("\n");
		}
		const sumsText = `${sum}  ${asset}\n`;
		const sumsBytes = new TextEncoder().encode(sumsText);

		test("verifyMinisign accepts a real signature and rejects tampering", () => {
			const sig = minisig(sumsBytes);
			expect(verifyMinisign(sumsBytes, sig, pub)).toBe(true);
			expect(verifyMinisign(new TextEncoder().encode(`${sumsText} `), sig, pub)).toBe(false);
			const lines = sig.split("\n");
			lines[2] = "trusted comment: something else";
			expect(verifyMinisign(sumsBytes, lines.join("\n"), pub)).toBe(false);
			expect(verifyMinisign(sumsBytes, minisig(sumsBytes, "c", Buffer.alloc(8)), pub)).toBe(false);
			const other = generateKeyPairSync("ed25519")
				.publicKey.export({ format: "der", type: "spki" })
				.subarray(-32);
			const otherPub = Buffer.concat([Buffer.from("Ed"), keyId, other]).toString("base64");
			expect(verifyMinisign(sumsBytes, sig, otherPub)).toBe(false);
		});

		test("with a release key: signed sums install, missing or bad signatures do not", async () => {
			const exe = join(dir, "8gent");
			const withSig = (sigBody: string | null): Routes => {
				const r = routes(sumsText);
				const list = r[RELEASES].body as ReturnType<typeof release>[];
				r[RELEASES] = {
					body: list.map((x) =>
						x.tag_name === "v0.20.0"
							? release("v0.20.0", true, sigBody === null ? [] : ["SHA256SUMS.minisig"])
							: x,
					),
				};
				if (sigBody !== null) r[`${DL}/v0.20.0/SHA256SUMS.minisig`] = { body: sigBody };
				return r;
			};

			writeFileSync(exe, "OLD");
			const missing = await base(exe, fakeFetch(withSig(null)), { signingKey: pub });
			expect(describeResult(missing)).toContain("unsigned checksums");
			expect(readFileSync(exe, "utf8")).toBe("OLD");

			const bad = await base(exe, fakeFetch(withSig(minisig(new TextEncoder().encode("other")))), {
				signingKey: pub,
			});
			expect(describeResult(bad)).toContain("valid release signature");
			expect(readFileSync(exe, "utf8")).toBe("OLD");

			const good = await base(exe, fakeFetch(withSig(minisig(sumsBytes))), { signingKey: pub });
			expect(good.status).toBe("updated");
			expect(readFileSync(exe, "utf8")).toBe("NEW-8GENT-0.20.0");
		});
	});

	test("the --version probe gives up after its time limit", async () => {
		const hang = join(dir, "hang.sh");
		writeFileSync(hang, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
		const t0 = Date.now();
		expect(await probeVersionWithTimeout(hang, 300)).toBe("");
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(PROBE_TIMEOUT_MS).toBe(15_000);
	});
});

test("only https and the right hosts pass the URL checks", () => {
	expect(
		urlAllowed("https://github.com/8gi-foundation/8gent-code/releases/download/v1.0.0/x", "asset"),
	).toBe(true);
	expect(urlAllowed("https://github.com/someone/else/releases/download/v1.0.0/x", "asset")).toBe(
		false,
	);
	expect(
		urlAllowed("http://github.com/8gi-foundation/8gent-code/releases/download/v1.0.0/x", "asset"),
	).toBe(false);
	const dl = "https://github.com/8gi-foundation/8gent-code/releases/download";
	expect(urlAllowed(`${dl}/../../../../evil/repo/releases/download/v1/x`, "asset")).toBe(false);
	expect(urlAllowed(`${dl}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/r/x`, "asset")).toBe(false);
	expect(
		urlAllowed("https://x@github.com/8gi-foundation/8gent-code/releases/download/v1/x", "asset"),
	).toBe(false);
	expect(urlAllowed("https://registry.npmjs.org/x", "npm")).toBe(true);
	expect(urlAllowed("https://evil.test/x", "npm")).toBe(false);
	expect(hopAllowed("https://objects.githubusercontent.com/x", "asset")).toBe(true);
	expect(hopAllowed("https://evil.test/x", "asset")).toBe(false);
	expect(hopAllowed("http://objects.githubusercontent.com/x", "asset")).toBe(false);
});

test("the embedded release signing key matches scripts/release-signing.pub", () => {
	const pub = readFileSync(
		join(import.meta.dir, "..", "..", "scripts", "release-signing.pub"),
		"utf8",
	)
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"))
		.join("")
		.trim();
	expect(RELEASE_SIGNING_KEY).toBe(pub);
});

test("source channel is handled by source-update, not the release engine", async () => {
	const r = await runSelfUpdate({
		currentVersion: "0.19.0",
		channel: "source",
		execPath: "x",
		fetchImpl: fakeFetch({}),
		log: () => {},
	});
	expect(r.status).toBe("source");
	expect(describeResult(r)).toContain("8gent update");
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

// (b4) Interop with the real minisign.
describe("verifyMinisign against the real minisign", () => {
	// Fixed vectors written by minisign 0.12 with a throwaway key (the secret
	// key was discarded): one default (prehashed, "ED") and one legacy ("Ed").
	const pub = "RWSh+VM93J6ir+mzQHIQcnpwQYHnwU/K4p2yT7/RU4ePwiCzJFHVPWUj";
	const msg = new TextEncoder().encode("aaaa  8gent-linux-x64\n");
	const prehashed = [
		"untrusted comment: signature from minisign secret key",
		"RUSh+VM93J6ir+kUc8CZFr1/KwiXkThqFlzx8t4tXHrQLDmLQTJvJ9liaUOXuBiQWpyDLRUbx3b+1NlwMXd55/VU7h/r5j0y8AA=",
		"trusted comment: 8gent v0.0.1 SHA256SUMS",
		"u82TutUuESIOBkVda9IoTH1NSFlUIDXsvdK5VKEbfdy3cV6PJNZwW9La804lX2cCf1DK/S7uxX/ezSEiHARBCg==",
		"",
	].join("\n");
	const legacy = [
		"untrusted comment: signature from minisign secret key",
		"RWSh+VM93J6irwm3attJDqqfFDJTGxippy3jwQywOJl02f7xOr0Vlbj19N/Lhw8pCN7w72aouYTro/xc+FYlUiHs89hkmBklBAQ=",
		"trusted comment: timestamp:1791752102\tfile:vec.msg",
		"2JPcgT0vfEH5x+eLA8jfOtbZoefoROr7+2iwTEi8KAGspgCWauZeE9XYg/exLC0UvRGzFzY1wdKM+u+DwlSuCA==",
		"",
	].join("\n");

	test("accepts signatures written by minisign 0.12, both formats", () => {
		expect(verifyMinisign(msg, prehashed, pub)).toBe(true);
		expect(verifyMinisign(msg, legacy, pub)).toBe(true);
	});

	test("rejects them for a changed message", () => {
		const changed = new TextEncoder().encode("aaab  8gent-linux-x64\n");
		expect(verifyMinisign(changed, prehashed, pub)).toBe(false);
		expect(verifyMinisign(changed, legacy, pub)).toBe(false);
	});

	// With a minisign binary available (MINISIGN_BIN or PATH), sign fresh
	// content with it now and verify in-process.
	const bin = process.env.MINISIGN_BIN || Bun.which("minisign");
	test.skipIf(!bin)("verifies what the installed minisign signs right now", () => {
		const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "minisign-interop-"));
		try {
			const run = (args: string[]) => {
				const r = Bun.spawnSync([bin as string, ...args], { stdin: "ignore" });
				if (r.exitCode !== 0) throw new Error(r.stderr.toString());
			};
			run(["-G", "-W", "-f", "-p", join(d, "k.pub"), "-s", join(d, "k.key")]);
			const key = readFileSync(join(d, "k.pub"), "utf8").split("\n")[1].trim();
			const body = `${"c".repeat(64)}  8gent-darwin-arm64\n`;
			writeFileSync(join(d, "SHA256SUMS"), body);
			run(["-S", "-s", join(d, "k.key"), "-m", join(d, "SHA256SUMS"), "-t", "8gent interop"]);
			const sig = readFileSync(join(d, "SHA256SUMS.minisig"), "utf8");
			expect(verifyMinisign(new TextEncoder().encode(body), sig, key)).toBe(true);
			expect(verifyMinisign(new TextEncoder().encode(`${body} `), sig, key)).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
