import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOCK_FILENAME,
	defaultPackagesRoot,
	editDistance,
	installPackage,
	listPackages,
	parseSource,
	readLock,
	removePackage,
	sri512,
	verifyPackage,
} from "./install";
import { member, tgz } from "./npm-tar.fixtures";

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
	const d = mkdtempSync(join(tmpdir(), p));
	made.push(d);
	return d;
};

const pkgJson = (version: string, name = "demo-ext") =>
	JSON.stringify({
		name,
		version,
		scripts: { postinstall: "touch /tmp/should-never-exist" },
		dependencies: { "left-pad": "1.0.0" },
		"8gent": { extensions: ["index.ts"] },
	});

/** A gzipped npm tarball with the given files under package/. */
const tarball = (files: Record<string, string>) =>
	tgz(...Object.entries(files).map(([rel, body]) => member(`package/${rel}`, body)));

const REG = "https://reg.test";

interface Fake {
	fetch: typeof fetch;
	calls: Array<{ url: string; init?: RequestInit }>;
	versions: Record<
		string,
		{ tgz: Uint8Array; integrity?: string; tarball?: string; version?: string }
	>;
	tags: Record<string, string>;
	time?: Record<string, string>;
	headers?: Record<string, string>;
}

function fakeRegistry(versions: Fake["versions"], base = REG): Fake {
	const fake: Fake = {
		calls: [],
		versions,
		tags: { latest: "1.0.0" },
		fetch: undefined as unknown as typeof fetch,
	};
	fake.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		fake.calls.push({ url, init });
		if (url === `${base}/demo-ext`) {
			return Response.json({
				"dist-tags": fake.tags,
				time: fake.time,
				versions: Object.fromEntries(
					Object.entries(fake.versions).map(([v, x]) => [
						v,
						{
							version: x.version ?? v,
							dist: {
								tarball: x.tarball ?? `${base}/demo-ext/-/demo-ext-${v}.tgz`,
								integrity: x.integrity ?? sri512(x.tgz),
							},
							dependencies: { "left-pad": "1.0.0" },
						},
					]),
				),
			});
		}
		const m = url.match(/demo-ext-(.+)\.tgz$/);
		if (m && fake.versions[m[1]]) {
			return new Response(Buffer.from(fake.versions[m[1]].tgz), { headers: fake.headers });
		}
		return new Response("nope", { status: 404 });
	}) as typeof fetch;
	return fake;
}

let root: string;
beforeEach(() => {
	root = join(tmp("pkg-home-"), ".8gent", "packages");
	mkdirSync(root, { recursive: true });
});

const opts = (f: Fake, extra: Record<string, unknown> = {}) => ({
	root,
	registry: REG,
	fetch: f.fetch,
	knownNames: [] as string[],
	...extra,
});

describe("installPackage (npm, pinned by integrity)", () => {
	test("installs the exact version, pins its integrity, runs no scripts, installs no dependencies", async () => {
		const t = tarball({ "package.json": pkgJson("1.0.0"), "index.ts": "export default () => {};" });
		const f = fakeRegistry({ "1.0.0": { tgz: t } });
		const r = await installPackage("npm:demo-ext@1.0.0", opts(f));
		expect(r.alreadyInstalled).toBe(false);
		expect(r.pkg.integrity).toBe(sri512(t));
		expect(r.dependencies).toEqual(["left-pad"]);
		expect(r.contributes).toEqual({ extensions: ["index.ts"] });
		expect(r.warnings).toEqual([]);
		expect(readFileSync(join(r.pkg.dir, "index.ts"), "utf-8")).toContain("export default");
		expect(existsSync("/tmp/should-never-exist")).toBe(false);
		expect(readLock(root).packages["demo-ext"].integrity).toBe(sri512(t));
		expect(verifyPackage("demo-ext", { root }).ok).toBe(true);
		expect(readdirSync(root).sort()).toEqual([LOCK_FILENAME, "demo-ext@1.0.0"].sort());
		// Every request refuses redirects.
		for (const c of f.calls) expect(c.init?.redirect).toBe("error");
	});

	test("the same pin again is a verified no-op: no tarball download", async () => {
		const f = fakeRegistry({ "1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0") }) } });
		await installPackage("npm:demo-ext@1.0.0", opts(f));
		f.calls.length = 0;
		const again = await installPackage("npm:demo-ext@1.0.0", opts(f));
		expect(again.alreadyInstalled).toBe(true);
		expect(f.calls.some((c) => c.url.endsWith(".tgz"))).toBe(false);
	});

	test("a tarball that does not match the registry integrity is refused and nothing is installed", async () => {
		const good = tarball({ "package.json": pkgJson("1.0.0") });
		const evil = tarball({ "package.json": pkgJson("1.0.0"), "evil.js": "steal()" });
		const f = fakeRegistry({ "1.0.0": { tgz: evil, integrity: sri512(good) } });
		await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow(
			"integrity mismatch",
		);
		expect(listPackages({ root })).toEqual([]);
		expect(existsSync(join(root, "demo-ext@1.0.0"))).toBe(false);
	});

	test("a pinned version whose registry integrity changed is refused, the pin is kept", async () => {
		const f = fakeRegistry({ "1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0") }) } });
		const first = await installPackage("npm:demo-ext@1.0.0", opts(f));
		f.versions["1.0.0"] = { tgz: tarball({ "package.json": pkgJson("1.0.0"), "x.js": "1" }) };
		await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow("is pinned to");
		expect(readLock(root).packages["demo-ext"].integrity).toBe(first.pkg.integrity);
	});

	test("a range is refused with a hint; a dist-tag resolves to an exact pin", async () => {
		const f = fakeRegistry({ "1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0") }) } });
		await expect(installPackage("npm:demo-ext@^1", opts(f))).rejects.toThrow("npm:demo-ext@1.0.0");
		const r = await installPackage("npm:demo-ext", opts(f));
		expect(r.pkg.source).toBe("npm:demo-ext@1.0.0");
	});

	test("I1: a dist-tag pointing at a path-like version is refused; nothing outside root is touched", async () => {
		const victim = join(root, "..", "..", "victim");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "CANARY"), "keep me");
		const v = "1.0.0/../../../victim";
		const f = fakeRegistry({ [v]: { tgz: tarball({ "package.json": pkgJson(v) }) } });
		f.tags = { latest: v };
		await expect(installPackage("npm:demo-ext@latest", opts(f))).rejects.toThrow(
			"not an exact version",
		);
		expect(readFileSync(join(victim, "CANARY"), "utf8")).toBe("keep me");
	});

	test("I1: a registry entry whose own version disagrees with its key is refused", async () => {
		const f = fakeRegistry({
			"1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0") }), version: "9.9.9" },
		});
		await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow(
			'says version "9.9.9"',
		);
	});

	test("I2: a lock entry pointing outside the root is refused, and its folder is never deleted", async () => {
		const precious = join(root, "..", "..", "precious");
		mkdirSync(precious, { recursive: true });
		writeFileSync(join(precious, "DATA"), "x");
		writeFileSync(
			join(root, LOCK_FILENAME),
			JSON.stringify({
				version: 1,
				packages: {
					"demo-ext": {
						name: "demo-ext",
						version: "0.0.1",
						source: "",
						integrity: "sha512-x",
						filesRootHash: "",
						tarball: "",
						dir: precious,
						installedAt: "",
					},
				},
			}),
		);
		const f = fakeRegistry({ "2.0.0": { tgz: tarball({ "package.json": pkgJson("2.0.0") }) } });
		await expect(installPackage("npm:demo-ext@2.0.0", opts(f))).rejects.toThrow("points outside");
		expect(() => removePackage("demo-ext", { root })).toThrow("points outside");
		expect(() => verifyPackage("demo-ext", { root })).toThrow("points outside");
		expect(existsSync(join(precious, "DATA"))).toBe(true);
	});

	test("I3: a tarball on another host or scheme is refused, never fetched", async () => {
		const t = tarball({ "package.json": pkgJson("1.0.0") });
		for (const url of [
			"https://evil.test/demo-ext-1.0.0.tgz",
			"http://reg.test/demo-ext-1.0.0.tgz",
			"file:///tmp/demo-ext-1.0.0.tgz",
		]) {
			const f = fakeRegistry({ "1.0.0": { tgz: t, tarball: url } });
			await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow(
				"not on the registry host",
			);
			expect(f.calls.some((c) => c.url === url)).toBe(false);
		}
	});

	test("I4: an http registry is refused; loopback http only with the test flag", async () => {
		const t = tarball({ "package.json": pkgJson("1.0.0") });
		const f = fakeRegistry({ "1.0.0": { tgz: t } }, "http://127.0.0.1:9");
		await expect(
			installPackage("npm:demo-ext@1.0.0", opts(f, { registry: "http://127.0.0.1:9" })),
		).rejects.toThrow("must be https");
		await expect(
			installPackage(
				"npm:demo-ext@1.0.0",
				opts(f, { registry: "http://evil.test", allowLoopbackHttp: true }),
			),
		).rejects.toThrow("must be https");
		const r = await installPackage(
			"npm:demo-ext@1.0.0",
			opts(f, { registry: "http://127.0.0.1:9", allowLoopbackHttp: true }),
		);
		expect(r.pkg.version).toBe("1.0.0");
	});

	test("I5: a declared or streamed size over the cap is refused", async () => {
		const t = tarball({ "package.json": pkgJson("1.0.0"), "pad.txt": "x".repeat(4000) });
		const f = fakeRegistry({ "1.0.0": { tgz: t } });
		f.headers = { "content-length": String(10_000_000) };
		await expect(
			installPackage("npm:demo-ext@1.0.0", opts(f, { maxBytes: 1_000_000 })),
		).rejects.toThrow("10000000 bytes, over");
		f.headers = undefined;
		await expect(installPackage("npm:demo-ext@1.0.0", opts(f, { maxBytes: 64 }))).rejects.toThrow(
			"over the 64 byte cap",
		);
	});

	test("I5/I6: a link entry or a case collision is refused before anything is written", async () => {
		for (const bad of [
			member("package/h", "", "1", { linkname: "/etc/hosts" }),
			member("package/PACKAGE.JSON", "{}"),
		]) {
			const t = tgz(member("package/package.json", pkgJson("1.0.0")), bad);
			const f = fakeRegistry({ "1.0.0": { tgz: t } });
			await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow(
				"refusing demo-ext@1.0.0",
			);
			expect(readdirSync(root)).toEqual([]);
		}
	});

	test("I7: a look-alike name and a brand-new package come back as warnings", async () => {
		const f = fakeRegistry({ "1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0") }) } });
		f.time = { created: "2026-10-01T00:00:00.000Z" };
		const r = await installPackage(
			"npm:demo-ext@1.0.0",
			opts(f, {
				knownNames: ["demo-ex", "unrelated-name"],
				now: new Date("2026-10-11T00:00:00Z"),
			}),
		);
		expect(r.warnings).toEqual([
			'"demo-ext" looks like "demo-ex": check it is the package you meant',
			'"demo-ext" was first published 10 day(s) ago',
		]);
		expect(editDistance("lodash", "lodahs")).toBe(2);
		expect(editDistance("react", "react")).toBe(0);
	});

	test("verify catches an edited file; remove deletes the folder and the pin", async () => {
		const f = fakeRegistry({
			"1.0.0": { tgz: tarball({ "package.json": pkgJson("1.0.0"), "index.ts": "a" }) },
		});
		const r = await installPackage("npm:demo-ext@1.0.0", opts(f));
		writeFileSync(join(r.pkg.dir, "index.ts"), "tampered");
		expect(verifyPackage("demo-ext", { root }).ok).toBe(false);
		expect(removePackage("demo-ext", { root })).toBe(true);
		expect(existsSync(r.pkg.dir)).toBe(false);
		expect(listPackages({ root })).toEqual([]);
		expect(removePackage("demo-ext", { root })).toBe(false);
	});

	test("the default root comes from the OS home directory", () => {
		expect(defaultPackagesRoot()).toBe(join(homedir(), ".8gent", "packages"));
	});
});

describe("parseSource", () => {
	test("npm names, scopes and versions", () => {
		expect(parseSource("npm:x@1.2.3")).toEqual({ kind: "npm", name: "x", version: "1.2.3" });
		expect(parseSource("npm:@s/x@2.0.0")).toEqual({ kind: "npm", name: "@s/x", version: "2.0.0" });
		expect(parseSource("npm:@s/x")).toEqual({ kind: "npm", name: "@s/x", version: undefined });
		expect(() => parseSource("git:x")).toThrow("only npm:");
		expect(() => parseSource("npm:../x")).toThrow("invalid npm package name");
		expect(() => parseSource("npm:x@1;rm")).toThrow("invalid version");
	});
});
