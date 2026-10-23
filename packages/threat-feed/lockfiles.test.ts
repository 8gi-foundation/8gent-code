import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isLockfilePath, mergeDeps, parseLockfile } from "./lockfiles";

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dir, "fixtures", n), "utf8");
const parse = (n: string) => parseLockfile(n, fx(n)) ?? [];
const names = (n: string) => parse(n).map((d) => `${d.name}@${d.version}`);

describe("lockfile parsers", () => {
	test("bun.lock handles trailing commas, scoped names, skips workspace and git specs", () => {
		expect(names("bun.lock")).toEqual(["lodash@4.17.15", "@scope/pkg@1.2.3"]);
	});
	test("package-lock.json v3 takes the innermost node_modules name and skips links", () => {
		expect(names("package-lock.json")).toEqual(["minimist@1.2.5", "@s/b@2.0.0"]);
	});
	test("pnpm-lock.yaml reads only the packages section, strips peer suffixes, both key styles", () => {
		expect(names("pnpm-lock.yaml")).toEqual([
			"axios@0.21.1",
			"@babel/core@7.0.0",
			"old-style@1.0.0",
		]);
	});
	test("requirements.txt keeps only == pins and normalises names", () => {
		expect(names("requirements.txt")).toEqual(["django@3.0.0", "requests@2.19.0"]);
	});
	test("poetry.lock ignores dependency sub-tables", () => {
		expect(names("poetry.lock")).toEqual(["jinja2@2.10", "markupsafe@1.0"]);
	});
	test("go.sum drops /go.mod lines and the v prefix", () => {
		expect(names("go.sum")).toEqual(["golang.org/x/text@0.3.0", "github.com/pkg/errors@0.9.1"]);
	});
	test("Cargo.lock skips workspace members with no source", () => {
		expect(names("Cargo.lock")).toEqual(["smallvec@0.6.9"]);
	});
	test("ecosystems map to OSV names", () => {
		expect(parse("go.sum")[0].ecosystem).toBe("Go");
		expect(parse("Cargo.lock")[0].ecosystem).toBe("crates.io");
		expect(parse("requirements.txt")[0].ecosystem).toBe("PyPI");
	});
	test("malformed JSON throws so the caller can record a skip", () => {
		expect(() => parseLockfile("package-lock.json", "{nope")).toThrow();
	});
});

describe("dev-only detection", () => {
	test("bun.lock: direct prod false, direct dev true", () => {
		const m = Object.fromEntries(parse("bun.lock").map((d) => [d.name, d.dev]));
		expect(m).toEqual({ lodash: false, "@scope/pkg": true });
	});
	test("package-lock.json uses the dev flag, absent means production", () => {
		const m = Object.fromEntries(parse("package-lock.json").map((d) => [d.name, d.dev]));
		expect(m).toEqual({ minimist: true, "@s/b": false });
	});
	test("formats that cannot say leave it unknown", () => {
		expect(parse("go.sum")[0].dev).toBeUndefined();
	});
	test("merge: any production path wins, all-dev stays dev, mixed unknown stays unknown", () => {
		const r = (dev?: boolean) => [
			{
				ecosystem: "npm" as const,
				name: "a",
				version: "1.0.0",
				...(dev === undefined ? {} : { dev }),
			},
		];
		expect(
			mergeDeps([
				{ path: "x", raws: r(true) },
				{ path: "y", raws: r(false) },
			])[0].dev,
		).toBe(false);
		expect(
			mergeDeps([
				{ path: "x", raws: r(true) },
				{ path: "y", raws: r(true) },
			])[0].dev,
		).toBe(true);
		expect(
			mergeDeps([
				{ path: "x", raws: r(true) },
				{ path: "y", raws: r() },
			])[0].dev,
		).toBeUndefined();
	});
});

describe("isLockfilePath", () => {
	test("accepts nested lockfiles, rejects node_modules and fixtures", () => {
		expect(isLockfilePath("apps/tui/bun.lock")).toBe(true);
		expect(isLockfilePath("requirements-dev.txt")).toBe(true);
		expect(isLockfilePath("node_modules/x/package-lock.json")).toBe(false);
		expect(isLockfilePath("tests/fixtures/go.sum")).toBe(false);
		expect(isLockfilePath("README.md")).toBe(false);
	});
});

describe("mergeDeps", () => {
	test("dedupes the same package version across files and records both paths", () => {
		const raws = [{ ecosystem: "npm" as const, name: "a", version: "1.0.0" }];
		const d = mergeDeps([
			{ path: "bun.lock", raws },
			{ path: "web/package-lock.json", raws },
		]);
		expect(d).toHaveLength(1);
		expect(d[0].files).toEqual(["bun.lock", "web/package-lock.json"]);
	});
});
