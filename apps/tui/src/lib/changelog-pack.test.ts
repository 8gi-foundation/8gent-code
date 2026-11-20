import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("CHANGELOG.md ships in the package", () => {
	test("npm pack --dry-run lists CHANGELOG.md", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
		const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(r.status).toBe(0);
		const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
		expect(files).toContain("CHANGELOG.md");
	});
});
