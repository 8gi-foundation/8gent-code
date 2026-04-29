import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractArchive } from "./archive";
import { verifyIntegrity } from "./integrity";
import { runPublish } from "./publish";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-publish-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeApp(opts: {
	dir: string;
	name?: string;
	version?: string;
	capabilities?: string[];
}) {
	const { dir } = opts;
	const name = opts.name ?? "demo-app";
	const version = opts.version ?? "1.0.0";
	const capabilities = opts.capabilities ?? [];

	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify(
			{
				manifestVersion: 1,
				name,
				version,
				author: "Tester",
				description: "Demo app for round-trip tests",
				license: "Apache-2.0",
				entry: "src/index.ts",
				capabilities,
			},
			null,
			2,
		),
	);
	fs.writeFileSync(path.join(dir, "SKILL.md"), "# demo\n");
	fs.writeFileSync(path.join(dir, "src/index.ts"), "export const x = 1;\n");
}

describe("runPublish", () => {
	it("builds, packs, and round-trips a minimal app", async () => {
		const appDir = path.join(tmpRoot, "app");
		fs.mkdirSync(appDir);
		writeApp({ dir: appDir });

		const outPath = path.join(tmpRoot, "demo-app-1.0.0.8gent-app.tar.gz");
		const result = await runPublish({
			appDir,
			outPath,
			tmpDir: tmpRoot,
		});

		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.archivePath).toBe(outPath);
		expect(fs.existsSync(outPath)).toBe(true);

		const verifyDir = fs.mkdtempSync(path.join(tmpRoot, "verify-"));
		extractArchive(outPath, verifyDir);
		const inner = path.join(verifyDir, "demo-app-1.0.0");
		expect(fs.existsSync(path.join(inner, "manifest.json"))).toBe(true);
		expect(fs.existsSync(path.join(inner, "SKILL.md"))).toBe(true);
		expect(fs.existsSync(path.join(inner, "src/index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(inner, "INTEGRITY.json"))).toBe(true);

		const v = verifyIntegrity(inner);
		expect(v.ok).toBe(true);
	});

	it("fails with exit 1 on malformed manifest", async () => {
		const appDir = path.join(tmpRoot, "bad");
		fs.mkdirSync(appDir);
		fs.writeFileSync(path.join(appDir, "manifest.json"), "{not json}");

		const result = await runPublish({ appDir, tmpDir: tmpRoot });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
	});

	it("blocks dangerous capability without override (exit 2)", async () => {
		const appDir = path.join(tmpRoot, "danger");
		fs.mkdirSync(appDir);
		writeApp({ dir: appDir, capabilities: ["dangerous"] });

		const result = await runPublish({ appDir, tmpDir: tmpRoot });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(2);
	});

	it("permits dangerous capability with override", async () => {
		const appDir = path.join(tmpRoot, "danger-ok");
		fs.mkdirSync(appDir);
		writeApp({ dir: appDir, capabilities: ["dangerous"] });

		const outPath = path.join(tmpRoot, "danger-ok-1.0.0.8gent-app.tar.gz");
		const result = await runPublish({
			appDir,
			outPath,
			allowDangerous: true,
			tmpDir: tmpRoot,
		});
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("rejects archives larger than the size limit (exit 3)", async () => {
		const appDir = path.join(tmpRoot, "big");
		fs.mkdirSync(appDir);
		writeApp({ dir: appDir });
		// 16 KiB of pseudo-random content; well above a 1 KiB limit.
		fs.writeFileSync(path.join(appDir, "src/big.bin"), Buffer.alloc(16 * 1024, 7));

		const result = await runPublish({
			appDir,
			tmpDir: tmpRoot,
			outPath: path.join(tmpRoot, "big-1.0.0.8gent-app.tar.gz"),
			maxBytes: 1024,
		});
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(3);
	});

	it("excludes node_modules and .git from staging", async () => {
		const appDir = path.join(tmpRoot, "with-noise");
		fs.mkdirSync(appDir);
		writeApp({ dir: appDir });
		fs.mkdirSync(path.join(appDir, "node_modules", "lodash"), { recursive: true });
		fs.writeFileSync(path.join(appDir, "node_modules", "lodash", "index.js"), "x");
		fs.mkdirSync(path.join(appDir, ".git"), { recursive: true });
		fs.writeFileSync(path.join(appDir, ".git", "HEAD"), "ref: x");

		const outPath = path.join(tmpRoot, "with-noise-1.0.0.8gent-app.tar.gz");
		const result = await runPublish({
			appDir,
			outPath,
			tmpDir: tmpRoot,
		});
		expect(result.ok).toBe(true);

		const verifyDir = fs.mkdtempSync(path.join(tmpRoot, "noise-verify-"));
		extractArchive(outPath, verifyDir);
		const inner = path.join(verifyDir, "demo-app-1.0.0");
		expect(fs.existsSync(path.join(inner, "node_modules"))).toBe(false);
		expect(fs.existsSync(path.join(inner, ".git"))).toBe(false);
	});
});
