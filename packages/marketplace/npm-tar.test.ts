import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readNpmTarball, writeEntries } from "./npm-tar";
import { member, pax, tgz } from "./npm-tar.fixtures";

const PKG = member("package/package.json", '{"name":"x","version":"1.0.0"}');

describe("readNpmTarball", () => {
	test("plain files and dirs under package/ are read; ustar prefix and pax path resolve", () => {
		const e = readNpmTarball(
			tgz(
				member("package/", "", "5"),
				PKG,
				member("index.js", "a", "0", { prefix: "package/lib" }),
				pax({ path: `package/${"d".repeat(120)}/long.js` }),
				member("package/short-name-replaced", "b"),
			),
		);
		expect(e.map((x) => [x.rel, x.type])).toEqual([
			["", "dir"],
			["package.json", "file"],
			["lib/index.js", "file"],
			[`${"d".repeat(120)}/long.js`, "file"],
		]);
	});

	for (const [label, bad, msg] of [
		["symlink", member("package/l", "", "2", { linkname: "/etc/passwd" }), "not accepted"],
		[
			"hardlink (absolute)",
			member("package/h", "", "1", { linkname: "/etc/hosts" }),
			"not accepted",
		],
		[
			"hardlink (relative)",
			member("package/h", "", "1", { linkname: "package/package.json" }),
			"not accepted",
		],
		["char device", member("package/c", "", "3"), "not accepted"],
		["fifo", member("package/f", "", "6"), "not accepted"],
		["absolute path", member("/etc/evil", "x"), "absolute"],
		["dot-dot", member("package/../evil", "x"), '".."'],
		["outside package/", member("other/x", "x"), "outside package/"],
		["backslash", member("package\\..\\x", "x"), "backslash"],
	] as const) {
		test(`refuses: ${label}`, () => {
			expect(() => readNpmTarball(tgz(PKG, bad))).toThrow(msg);
		});
	}

	test("refuses a pax path override with .. (the short name looked safe)", () => {
		expect(() =>
			readNpmTarball(
				tgz(PKG, pax({ path: "package/a/../../../escape.txt" }), member("package/ok.txt", "e")),
			),
		).toThrow('".."');
	});

	test("refuses a GNU long name with ..", () => {
		expect(() =>
			readNpmTarball(
				tgz(PKG, member("././@LongLink", "package/../../x", "L"), member("package/ok", "e")),
			),
		).toThrow('".."');
	});

	test("refuses a pax global header that sets a path", () => {
		const g = pax({ path: "package/../x" });
		g[156] = "g".charCodeAt(0);
		// Fix the checksum after changing the type byte.
		g.fill(32, 148, 156);
		let sum = 0;
		for (const b of g.subarray(0, 512)) sum += b;
		g.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
		expect(() => readNpmTarball(tgz(g, PKG))).toThrow("global header");
	});

	test("refuses members that collide by case or Unicode form", () => {
		expect(() =>
			readNpmTarball(tgz(PKG, member("package/A.js", "x"), member("package/a.js", "y"))),
		).toThrow("collides");
		expect(() =>
			readNpmTarball(tgz(PKG, member("package/café.js", "x"), member("package/café.js", "y"))),
		).toThrow("collides");
	});

	test("entry and size caps, and a gzip bomb, are refused", () => {
		expect(() =>
			readNpmTarball(tgz(PKG, member("package/a", "1"), member("package/b", "2")), {
				maxEntries: 2,
			}),
		).toThrow("more than 2 members");
		expect(() =>
			readNpmTarball(tgz(PKG, member("package/big", "x".repeat(5000))), { maxUnpacked: 4096 }),
		).toThrow("more than 4096 bytes");
		const bomb = new Uint8Array(gzipSync(new Uint8Array(40 * 1024 * 1024)));
		expect(bomb.length).toBeLessThan(100 * 1024);
		expect(() => readNpmTarball(bomb, { maxUnpacked: 1024 * 1024 })).toThrow("size cap");
	});

	test("writeEntries writes plain files with plain modes and never replaces anything", () => {
		const dir = mkdtempSync(join(tmpdir(), "npmtar-"));
		try {
			const entries = readNpmTarball(tgz(PKG, member("package/lib/a.js", "hello")));
			writeEntries(entries, join(dir, "out"));
			expect(readFileSync(join(dir, "out", "lib", "a.js"), "utf8")).toBe("hello");
			expect(() => writeEntries(entries, join(dir, "out"))).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
