import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findWorkspaceSpecifiers, scanRepo, scanTarball, syncInternalPins, workspaceManifests } from "./no-workspace-protocol";

const ROOT = resolve(import.meta.dir, "..", "..");

describe("no workspace: protocol", () => {
	test("flags workspace: in any dependency field, including nested overrides", () => {
		const hits = findWorkspaceSpecifiers(
			{
				dependencies: { a: "workspace:*" },
				devDependencies: { b: "workspace:^" },
				overrides: { c: { d: "workspace:~" } },
				peerDependencies: { e: "^1.0.0" },
			},
			"x/package.json",
		);
		expect(hits.map((h) => h.name).sort()).toEqual(["a", "b", "d"]);
	});

	test("every manifest in the repo is installable by npm", () => {
		expect(scanRepo(ROOT)).toEqual([]);
	});

	test("the npm tarball's package.json carries no workspace: specifier", () => {
		const dir = mkdtempSync(join(tmpdir(), "nwp-"));
		const bad = join(dir, "bad");
		mkdirSync(join(bad, "package"), { recursive: true });
		writeFileSync(join(bad, "package", "package.json"), JSON.stringify({ name: "x", dependencies: { y: "workspace:*" } }));
		const tgz = join(dir, "bad.tgz");
		spawnSync("tar", ["-czf", tgz, "-C", bad, "package"]);
		expect(scanTarball(tgz)).toHaveLength(1);

		const ok = join(dir, "ok");
		mkdirSync(join(ok, "package"), { recursive: true });
		writeFileSync(join(ok, "package", "package.json"), JSON.stringify({ name: "x", dependencies: { y: "*" } }));
		const okTgz = join(dir, "ok.tgz");
		spawnSync("tar", ["-czf", okTgz, "-C", ok, "package"]);
		expect(scanTarball(okTgz)).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("internal pins follow the workspace version on a release bump", () => {
		const versions = new Map([["@8gent/eyes", "0.19.0"]]);
		const text = '{"dependencies": {"@8gent/eyes": "0.18.0", "zod": "^4.0.0", "@8gent/other": "1.0.0"}}';
		expect(syncInternalPins(text, versions)).toBe(
			'{"dependencies": {"@8gent/eyes": "0.19.0", "zod": "^4.0.0", "@8gent/other": "1.0.0"}}',
		);
	});

	test("nested workspace globs are walked", () => {
		const dir = mkdtempSync(join(tmpdir(), "nwp-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "r", workspaces: ["apps/*", "libs/*/pkg"] }));
		for (const p of ["apps/a", "libs/x/pkg", "libs/y/pkg", "libs/z/other"]) {
			mkdirSync(join(dir, p), { recursive: true });
			writeFileSync(join(dir, p, "package.json"), JSON.stringify({ name: p, version: "1.0.0" }));
		}
		const found = workspaceManifests(dir).map((f) => f.slice(dir.length + 1)).sort();
		expect(found).toEqual(["apps/a/package.json", "libs/x/pkg/package.json", "libs/y/pkg/package.json", "package.json"]);
		rmSync(dir, { recursive: true, force: true });
	});
});
