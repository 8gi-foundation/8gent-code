import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOCK_FILENAME,
	installPackage,
	listPackages,
	parseSource,
	readLock,
	removePackage,
	sri512,
	verifyPackage,
} from "./install";

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
	const d = mkdtempSync(join(tmpdir(), p));
	made.push(d);
	return d;
};

/** Build an npm-style tarball (entries under package/) and return its bytes. */
function tarball(files: Record<string, string>, extra?: (pkgDir: string) => void): Uint8Array {
	const work = tmp("pkg-src-");
	const pkgDir = join(work, "package");
	mkdirSync(pkgDir, { recursive: true });
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(join(pkgDir, rel, ".."), { recursive: true });
		writeFileSync(join(pkgDir, rel), body);
	}
	extra?.(pkgDir);
	const res = spawnSync("tar", ["-czf", "out.tgz", "package"], { cwd: work });
	if (res.status !== 0) throw new Error("tar failed");
	return new Uint8Array(readFileSync(join(work, "out.tgz")));
}

const MARKER = join(tmpdir(), `l5-postinstall-${process.pid}`);
const pkgJson = (version: string) =>
	JSON.stringify({
		name: "demo-ext",
		version,
		scripts: { postinstall: `touch ${MARKER}` },
		dependencies: { "left-pad": "1.0.0" },
		"8gent": { extensions: ["index.ts"] },
	});

interface Fake {
	fetch: typeof fetch;
	calls: string[];
	versions: Record<string, { tgz: Uint8Array; integrity?: string }>;
}

function fakeRegistry(versions: Fake["versions"], latest = "1.0.0"): Fake {
	const fake: Fake = { calls: [], versions, fetch: undefined as unknown as typeof fetch };
	fake.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		fake.calls.push(url);
		if (url === "https://reg.test/demo-ext") {
			const doc = {
				"dist-tags": { latest },
				versions: Object.fromEntries(
					Object.entries(fake.versions).map(([v, x]) => [
						v,
						{
							version: v,
							dist: {
								tarball: `https://reg.test/demo-ext/-/demo-ext-${v}.tgz`,
								integrity: x.integrity ?? sri512(x.tgz),
							},
							dependencies: { "left-pad": "1.0.0" },
						},
					]),
				),
			};
			return Response.json(doc);
		}
		const m = url.match(/demo-ext-(.+)\.tgz$/);
		if (m && fake.versions[m[1]]) return new Response(Buffer.from(fake.versions[m[1]].tgz));
		return new Response("nope", { status: 404 });
	}) as typeof fetch;
	return fake;
}

let root: string;
beforeEach(() => {
	root = tmp("pkg-root-");
	rmSync(MARKER, { force: true });
});

const opts = (f: Fake) => ({ root, registry: "https://reg.test", fetch: f.fetch });

describe("installPackage (npm, pinned by integrity)", () => {
	test("installs the exact version, pins its integrity, runs no scripts, installs no dependencies", async () => {
		const tgz = tarball({
			"package.json": pkgJson("1.0.0"),
			"index.ts": "export default () => {};",
		});
		const f = fakeRegistry({ "1.0.0": { tgz } });
		const r = await installPackage("npm:demo-ext@1.0.0", opts(f));
		expect(r.alreadyInstalled).toBe(false);
		expect(r.pkg.version).toBe("1.0.0");
		expect(r.pkg.integrity).toBe(sri512(tgz));
		expect(r.dependencies).toEqual(["left-pad"]);
		expect(r.contributes).toEqual({ extensions: ["index.ts"] });
		expect(readFileSync(join(r.pkg.dir, "index.ts"), "utf-8")).toContain("export default");
		expect(existsSync(MARKER)).toBe(false);
		expect(readLock(root).packages["demo-ext"].integrity).toBe(sri512(tgz));
		expect(verifyPackage("demo-ext", { root }).ok).toBe(true);
		// No staging folder left behind.
		expect(readdirSync(root).sort()).toEqual([LOCK_FILENAME, "demo-ext@1.0.0"].sort());
	});

	test("the same pin again is a verified no-op: no tarball download", async () => {
		const tgz = tarball({ "package.json": pkgJson("1.0.0") });
		const f = fakeRegistry({ "1.0.0": { tgz } });
		await installPackage("npm:demo-ext@1.0.0", opts(f));
		f.calls.length = 0;
		const again = await installPackage("npm:demo-ext@1.0.0", opts(f));
		expect(again.alreadyInstalled).toBe(true);
		expect(f.calls.some((u) => u.endsWith(".tgz"))).toBe(false);
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
		const tgz = tarball({ "package.json": pkgJson("1.0.0") });
		const f = fakeRegistry({ "1.0.0": { tgz } });
		const first = await installPackage("npm:demo-ext@1.0.0", opts(f));
		const swapped = tarball({ "package.json": pkgJson("1.0.0"), "x.js": "1" });
		f.versions["1.0.0"] = { tgz: swapped };
		await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow("is pinned to");
		expect(readLock(root).packages["demo-ext"].integrity).toBe(first.pkg.integrity);
	});

	test("a range is refused with a hint; a dist-tag resolves to an exact pin", async () => {
		const tgz = tarball({ "package.json": pkgJson("1.0.0") });
		const f = fakeRegistry({ "1.0.0": { tgz } });
		await expect(installPackage("npm:demo-ext@^1", opts(f))).rejects.toThrow("npm:demo-ext@1.0.0");
		const r = await installPackage("npm:demo-ext", opts(f));
		expect(r.pkg.source).toBe("npm:demo-ext@1.0.0");
	});

	// Creating a symlink needs extra privileges on Windows.
	test.skipIf(process.platform === "win32")(
		"a tarball with a symlink entry is refused",
		async () => {
			const tgz = tarball({ "package.json": pkgJson("1.0.0") }, (dir) =>
				symlinkSync("/etc/passwd", join(dir, "link")),
			);
			const f = fakeRegistry({ "1.0.0": { tgz } });
			await expect(installPackage("npm:demo-ext@1.0.0", opts(f))).rejects.toThrow(
				"not a plain file",
			);
			expect(listPackages({ root })).toEqual([]);
		},
	);

	test("verify catches an edited file; remove deletes the folder and the pin", async () => {
		const tgz = tarball({ "package.json": pkgJson("1.0.0"), "index.ts": "a" });
		const f = fakeRegistry({ "1.0.0": { tgz } });
		const r = await installPackage("npm:demo-ext@1.0.0", opts(f));
		writeFileSync(join(r.pkg.dir, "index.ts"), "tampered");
		expect(verifyPackage("demo-ext", { root }).ok).toBe(false);
		expect(removePackage("demo-ext", { root })).toBe(true);
		expect(existsSync(r.pkg.dir)).toBe(false);
		expect(listPackages({ root })).toEqual([]);
		expect(removePackage("demo-ext", { root })).toBe(false);
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
