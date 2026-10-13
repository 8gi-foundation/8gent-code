/**
 * `8gent update`, `8gent install npm:` and `8gent packages` as a user sees
 * them: what prints, what exits, what is never run. Fake release source and
 * fake registry; nothing on the network, nothing installed globally.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { member, tgz } from "../marketplace/npm-tar.fixtures";
import { sri512 } from "../marketplace/install";
import {
	checkUpdate,
	packagesRoot,
	parseUpdateArgs,
	interactiveRefusal,
	isInteractiveTerminal,
	registryFromEnv,
	runInstallNpmCommand,
	runPackagesCommand,
	runUpdateCommand,
	type UpdateCliDeps,
} from "./cli-maintenance";
import type { FetchLike } from "./self-update";

// ── fakes ──────────────────────────────────────────────────────────────

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
			headers: { get: () => null },
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
			arrayBuffer: async () => new TextEncoder().encode(String(body ?? "")).buffer as ArrayBuffer,
		};
	}) as unknown as FetchLike & { calls: string[] };
	f.calls = calls;
	return f;
}

const RELEASES = "https://releases.test/list";
const DL = "https://github.com/8gi-foundation/8gent-code/releases/download";
const ASSET = "8gent-linux-x64";
const release = (v: string) => ({
	tag_name: `v${v}`,
	draft: false,
	prerelease: false,
	assets: [ASSET, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `${DL}/v${v}/${name}` })),
});
const releases = (...versions: string[]): Routes => ({ [RELEASES]: { body: versions.map(release) } });
const NPM_URL = "https://registry.npmjs.org/@8gi-foundation%2f8gent-code";
const npmLatest = (v: string): Routes => ({ [NPM_URL]: { body: { "dist-tags": { latest: v } } } });

/** A binary install (module path under $bunfs), v0.18.0, linux x64, fake release list. */
function binaryDeps(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
	const lines: string[] = [];
	const ran: string[][] = [];
	return {
		lines,
		ran,
		deps: {
			currentVersion: "0.18.0",
			modulePath: "/$bunfs/root/8gent",
			embedded: true,
			execPath: "/usr/local/bin/8gent",
			platform: "linux",
			arch: "x64",
			fetchImpl,
			env: { EIGHT_RELEASES_URL: RELEASES },
			interactive: true,
			log: (l: string) => lines.push(l),
			run: async (cmd: string, args: string[]) => {
				ran.push([cmd, ...args]);
				return 0;
			},
			...extra,
		},
	};
}

// ── update ─────────────────────────────────────────────────────────────

describe("8gent update", () => {
	test("a lower version on the release source is refused: exit 0, both versions named, no download", async () => {
		const f = fakeFetch(releases("0.17.0", "0.9.0"));
		const { deps, lines, ran } = binaryDeps(f);
		expect(await runUpdateCommand([], deps)).toBe(0);
		expect(lines.join("\n")).toContain("Not updating: the newest release version is v0.17.0, lower than this v0.18.0");
		expect(f.calls).toEqual([RELEASES]);
		expect(ran).toEqual([]);
	});

	test("an equal version is up to date; nothing runs", async () => {
		const f = fakeFetch(releases("0.18.0"));
		const { deps, lines, ran } = binaryDeps(f);
		expect(await runUpdateCommand([], deps)).toBe(0);
		expect(lines.at(-1)).toBe("8gent v0.18.0 is the newest release.");
		expect(ran).toEqual([]);
	});

	test("the npm channel installs the exact newer version, never @latest and never when lower", async () => {
		const higher = fakeFetch(npmLatest("0.19.0"));
		const a = binaryDeps(higher, { modulePath: "/usr/lib/node_modules/@8gi-foundation/8gent-code/dist/cli.js", embedded: false });
		expect(await runUpdateCommand([], a.deps)).toBe(0);
		expect(a.ran).toHaveLength(1);
		expect(a.ran[0].join(" ")).toContain("@8gi-foundation/8gent-code@0.19.0");
		expect(a.ran[0].join(" ")).not.toContain("@latest");
		expect(a.lines.join("\n")).toContain("Updated to v0.19.0. Run 8gent, then /changelog to see what changed.");

		const lower = fakeFetch(npmLatest("0.17.0"));
		const b = binaryDeps(lower, { modulePath: "/usr/lib/node_modules/@8gi-foundation/8gent-code/dist/cli.js", embedded: false });
		expect(await runUpdateCommand([], b.deps)).toBe(0);
		expect(b.ran).toEqual([]);
		expect(b.lines.join("\n")).toContain("newest npm version is v0.17.0, lower than this v0.18.0");
	});

	test("--check on a source checkout compares with origin through git; the network is never touched", async () => {
		const f = fakeFetch({});
		const dir = mkdtempSync(join(tmpdir(), "src-co-"));
		made.push(dir);
		Bun.write(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
		await Bun.sleep(5);
		const { deps: d0, lines } = binaryDeps(f, { modulePath: `file://${dir}/bin/8gent.ts`, embedded: false });
		const deps = d0 as unknown as UpdateCliDeps;
		deps.sourceHasGit = (d) => d === dir;
		deps.homeDir = dir;
		deps.sourceIsFile = () => true;
		deps.env = { PATH: "/usr/bin" };
		deps.platform = "linux";
		deps.sourceExec = async (_f, a) => {
			const j = a.join(" ");
			if (j.includes("show-toplevel")) return { code: 0, stdout: dir, stderr: "" };
			if (j.includes("rev-parse HEAD")) return { code: 0, stdout: "a".repeat(40), stderr: "" };
			if (j.includes("symbolic-ref")) return { code: 0, stdout: "main\n", stderr: "" };
			if (j.includes("remote get-url")) return { code: 0, stdout: "x", stderr: "" };
			if (j.includes("status")) return { code: 0, stdout: "", stderr: "" };
			if (j.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
			if (j.includes("refs/remotes/origin/main") && j.includes("rev-parse")) return { code: 0, stdout: "a".repeat(40), stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		};
		expect(await runUpdateCommand(["--check"], deps)).toBe(0);
		expect(lines.join("\n")).toContain("up to date");
		expect(f.calls).toEqual([]);
	});

	test("a plain update on a source checkout needs a person at a terminal", async () => {
		const f = fakeFetch({});
		const dir = mkdtempSync(join(tmpdir(), "src-co-"));
		made.push(dir);
		Bun.write(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
		await Bun.sleep(5);
		const { deps, lines, ran } = binaryDeps(f, { modulePath: `file://${dir}/bin/8gent.ts`, embedded: false, interactive: false });
		expect(await runUpdateCommand([], deps)).toBe(1);
		expect(lines).toContain(interactiveRefusal("8gent update"));
		expect(f.calls).toEqual([]);
		expect(ran).toEqual([]);
	});

	test("a failed update exits 1 and says why", async () => {
		const f = fakeFetch({ [RELEASES]: { status: 503, body: "down" } });
		const { deps, lines } = binaryDeps(f);
		expect(await runUpdateCommand([], deps)).toBe(1);
		expect(lines.at(-1)).toContain("Update failed: GitHub releases answered 503");
	});

	test("EIGHT_RELEASES_URL that is not https is refused before any request", async () => {
		const f = fakeFetch(releases("0.19.0"));
		const { deps, lines, ran } = binaryDeps(f, { env: { EIGHT_RELEASES_URL: "http://127.0.0.1:9/list" } });
		expect(await runUpdateCommand([], deps)).toBe(1);
		expect(lines.at(-1)).toContain("refusing to download from http://127.0.0.1:9/list");
		expect(f.calls).toEqual([]);
		expect(ran).toEqual([]);
	});

	test("--check reports and installs nothing; --channel needs --check", async () => {
		const f = fakeFetch(releases("0.19.0"));
		const { deps, lines, ran } = binaryDeps(f);
		expect(await runUpdateCommand(["--check"], deps)).toBe(0);
		expect(lines.at(-1)).toBe("v0.19.0 is available (this is v0.18.0, binary channel). Run: 8gent update");
		expect(ran).toEqual([]);
		expect(f.calls).toEqual([RELEASES]);

		const src = binaryDeps(fakeFetch(releases("0.17.0")), { modulePath: "/$bunfs/root/8gent" });
		expect(await runUpdateCommand(["--check", "--channel", "binary"], src.deps)).toBe(0);
		expect(src.lines.at(-1)).toContain("lower than this v0.18.0");

		const bad = binaryDeps(f);
		expect(await runUpdateCommand(["--channel", "npm"], bad.deps)).toBe(2);
		expect(bad.lines[0]).toContain("--channel only applies to --check");
		expect(bad.ran).toEqual([]);

		expect(parseUpdateArgs(["--channel=source"]).error).toContain("must be binary or npm");
		expect(parseUpdateArgs(["--bogus"]).error).toContain("unknown option");
	});

	test("checkUpdate: no binary for the platform, no release carrying it", async () => {
		const base = { currentVersion: "0.18.0", channel: "binary" as const, fetchImpl: fakeFetch(releases("0.19.0")), releasesUrl: RELEASES };
		expect((await checkUpdate({ ...base, platform: "freebsd", arch: "x64" })).status).toBe("failed");
		const r = await checkUpdate({ ...base, platform: "darwin", arch: "arm64" });
		expect(r.status).toBe("failed");
		expect(r.status === "failed" && r.message).toContain("no release carries 8gent-darwin-arm64");
	});
});

// ── install npm: / packages ─────────────────────────────────────────────

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

const REG = "https://reg.test";
const pkgJson = (version: string) =>
	JSON.stringify({
		name: "demo-ext",
		version,
		scripts: { postinstall: "touch /tmp/should-never-exist" },
		dependencies: { "left-pad": "1.0.0" },
		"8gent": { extensions: ["index.ts"] },
	});
const tarball = (version: string) =>
	tgz(member("package/package.json", pkgJson(version)), member("package/index.ts", "export default 1;\n"));

function fakeRegistry(base = REG) {
	const calls: string[] = [];
	const tgz100 = tarball("1.0.0");
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url === `${base}/demo-ext`) {
			return Response.json({
				"dist-tags": { latest: "1.0.0" },
				time: { created: "2020-01-01T00:00:00.000Z" },
				versions: {
					"1.0.0": {
						version: "1.0.0",
						dist: { tarball: `${base}/demo-ext/-/demo-ext-1.0.0.tgz`, integrity: sri512(tgz100) },
						dependencies: { "left-pad": "1.0.0" },
					},
				},
			});
		}
		if (url.endsWith("demo-ext-1.0.0.tgz")) return new Response(Buffer.from(tgz100));
		return new Response("nope", { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

function tempHome() {
	const home = mkdtempSync(join(tmpdir(), "pkg-cli-home-"));
	made.push(home);
	return home;
}

describe("8gent install npm: and 8gent packages", () => {
	test("installs the exact version into EIGHT_HOME, lists it, removes it", async () => {
		const home = tempHome();
		const env = { EIGHT_HOME: home, EIGHT_PACKAGE_REGISTRY: REG };
		const reg = fakeRegistry();
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);

		expect(packagesRoot(env)).toBe(join(home, ".8gent", "packages"));
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env, log, fetch: reg.fetch, interactive: true })).toBe(0);
		const dir = join(home, ".8gent", "packages", "demo-ext@1.0.0");
		expect(lines[0]).toBe(`Installed demo-ext@1.0.0 into ${dir}`);
		expect(lines.join("\n")).toContain("Pinned by registry integrity: sha512-");
		expect(lines.join("\n")).toContain("Package scripts were not run.");
		expect(lines.join("\n")).toContain("Not installed, declared as dependencies: left-pad");
		expect(existsSync(join(dir, "index.ts"))).toBe(true);
		expect(existsSync("/tmp/should-never-exist")).toBe(false);

		lines.length = 0;
		expect(runPackagesCommand(["list"], { env, log })).toBe(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`demo-ext@1.0.0  ${dir}`);

		lines.length = 0;
		expect(runPackagesCommand(["verify", "demo-ext"], { env, log })).toBe(0);
		expect(lines[0]).toBe("demo-ext: files match the pin.");

		// The same pin again downloads nothing.
		const before = reg.calls.length;
		lines.length = 0;
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env, log, fetch: reg.fetch, interactive: true })).toBe(0);
		expect(lines[0]).toContain("already installed and verified");
		expect(reg.calls.slice(before).some((u) => u.endsWith(".tgz"))).toBe(false);

		lines.length = 0;
		expect(runPackagesCommand(["remove", "demo-ext"], { env, log, interactive: true })).toBe(0);
		expect(lines[0]).toBe("Removed demo-ext.");
		expect(existsSync(dir)).toBe(false);
		expect(runPackagesCommand(["remove", "demo-ext"], { env, log, interactive: true })).toBe(1);
		lines.length = 0;
		expect(runPackagesCommand([], { env, log })).toBe(0);
		expect(lines[0]).toContain("No packages installed under");
	});

	test("a range, an unknown name and a bad subcommand are refused with a readable line", async () => {
		const env = { EIGHT_HOME: tempHome(), EIGHT_PACKAGE_REGISTRY: REG };
		const reg = fakeRegistry();
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		expect(await runInstallNpmCommand("npm:demo-ext@^1", { env, log, fetch: reg.fetch, interactive: true })).toBe(1);
		expect(lines[0]).toContain("Install refused:");
		expect(lines[0]).toContain("pin one, e.g. npm:demo-ext@1.0.0");
		lines.length = 0;
		expect(await runInstallNpmCommand("npm:nope@1.0.0", { env, log, fetch: reg.fetch, interactive: true })).toBe(1);
		expect(lines[0]).toContain("answered 404");
		lines.length = 0;
		expect(runPackagesCommand(["dance"], { env, log })).toBe(2);
		expect(lines[0]).toContain("Usage: 8gent packages");
		expect(runPackagesCommand(["remove"], { env, log, interactive: true })).toBe(2);
	});

	test("EIGHT_PACKAGE_REGISTRY: https or loopback http only", async () => {
		expect(registryFromEnv({})).toEqual({});
		expect(registryFromEnv({ EIGHT_PACKAGE_REGISTRY: "http://127.0.0.1:4873" })).toEqual({ registry: "http://127.0.0.1:4873", allowLoopbackHttp: true });
		expect(registryFromEnv({ EIGHT_PACKAGE_REGISTRY: "http://evil.test" })).toEqual({ registry: "http://evil.test" });

		const home = tempHome();
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		const reg = fakeRegistry("http://evil.test");
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env: { EIGHT_HOME: home, EIGHT_PACKAGE_REGISTRY: "http://evil.test" }, log, fetch: reg.fetch, interactive: true })).toBe(1);
		expect(lines[0]).toContain("registry must be https");
		expect(reg.calls).toEqual([]);

		const loop = fakeRegistry("http://127.0.0.1:4873");
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env: { EIGHT_HOME: home, EIGHT_PACKAGE_REGISTRY: "http://127.0.0.1:4873" }, log, fetch: loop.fetch, interactive: true })).toBe(0);
		expect(loop.calls[0]).toBe("http://127.0.0.1:4873/demo-ext");
	});
});

// ── interactive gate (stdin AND stdout must be TTYs) ────────────────────

describe("interactive gate", () => {
	test("install: refused when not interactive, reaches the installer when it is", async () => {
		const home = tempHome();
		const env = { EIGHT_HOME: home, EIGHT_PACKAGE_REGISTRY: REG };
		const reg = fakeRegistry();
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env, log, fetch: reg.fetch, interactive: false })).toBe(1);
		expect(lines).toEqual([interactiveRefusal("8gent install npm:demo-ext@1.0.0")]);
		expect(lines[0]).toContain("needs a person at an interactive terminal");
		expect(reg.calls).toEqual([]);
		expect(existsSync(join(home, ".8gent", "packages", "demo-ext@1.0.0"))).toBe(false);

		lines.length = 0;
		expect(await runInstallNpmCommand("npm:demo-ext@1.0.0", { env, log, fetch: reg.fetch, interactive: true })).toBe(0);
		expect(reg.calls.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("Installed demo-ext@1.0.0");
	});

	test("remove: refused when not interactive and the package stays; list and verify stay open", async () => {
		const home = tempHome();
		const env = { EIGHT_HOME: home, EIGHT_PACKAGE_REGISTRY: REG };
		const reg = fakeRegistry();
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		await runInstallNpmCommand("npm:demo-ext@1.0.0", { env, log, fetch: reg.fetch, interactive: true });
		const dir = join(home, ".8gent", "packages", "demo-ext@1.0.0");

		lines.length = 0;
		expect(runPackagesCommand(["remove", "demo-ext"], { env, log, interactive: false })).toBe(1);
		expect(lines).toEqual([interactiveRefusal("8gent packages remove demo-ext")]);
		expect(existsSync(dir)).toBe(true);

		expect(runPackagesCommand(["list"], { env, log, interactive: false })).toBe(0);
		expect(runPackagesCommand(["verify", "demo-ext"], { env, log, interactive: false })).toBe(0);

		expect(runPackagesCommand(["remove", "demo-ext"], { env, log, interactive: true })).toBe(0);
		expect(existsSync(dir)).toBe(false);
	});

	test("update: a real update is refused when not interactive and never reaches the engine; --check is not gated", async () => {
		const f = fakeFetch(releases("0.19.0"));
		let engineCalls = 0;
		const selfUpdate = async () => {
			engineCalls++;
			return { status: "updated", from: "0.18.0", to: "0.19.0", channel: "binary" } as never;
		};
		const refused = binaryDeps(f, { interactive: false, selfUpdate });
		expect(await runUpdateCommand([], refused.deps)).toBe(1);
		expect(refused.lines.at(-1)).toBe(interactiveRefusal("8gent update"));
		expect(engineCalls).toBe(0);
		expect(refused.ran).toEqual([]);

		const check = binaryDeps(f, { interactive: false, selfUpdate });
		expect(await runUpdateCommand(["--check"], check.deps)).toBe(0);
		expect(check.lines.at(-1)).toContain("v0.19.0 is available");

		const allowed = binaryDeps(f, { interactive: true, selfUpdate });
		await runUpdateCommand([], allowed.deps);
		expect(engineCalls).toBe(1);
	});

	test("isInteractiveTerminal needs stdin AND stdout to be TTYs (properties restored afterwards)", () => {
		const inD = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const outD = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const set = (s: object, v: boolean) => Object.defineProperty(s, "isTTY", { value: v, configurable: true, writable: true });
		try {
			set(process.stdin, true);
			set(process.stdout, true);
			expect(isInteractiveTerminal()).toBe(true);
			set(process.stdin, false);
			expect(isInteractiveTerminal()).toBe(false);
			set(process.stdin, true);
			set(process.stdout, false);
			expect(isInteractiveTerminal()).toBe(false);
		} finally {
			for (const [s, d] of [[process.stdin, inD], [process.stdout, outD]] as const) {
				if (d) Object.defineProperty(s, "isTTY", d);
				else delete (s as { isTTY?: boolean }).isTTY;
			}
		}
	});
});
