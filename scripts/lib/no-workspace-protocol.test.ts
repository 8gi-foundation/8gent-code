import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findWorkspaceSpecifiers, scanRepo, scanTarball } from "./no-workspace-protocol";

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
});
