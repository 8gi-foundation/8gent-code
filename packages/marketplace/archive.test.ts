import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	auditArchiveEntries,
	buildArchive,
	extractArchive,
	stageAppDirectory,
	tarPathFrom,
} from "./archive";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-archive-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A one-file app staged under `rootName`, ready for buildArchive. */
function stage(rootName: string): string {
	const src = path.join(tmpRoot, "src-app");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(src, "manifest.json"), "{}");
	const stagingDir = path.join(tmpRoot, "staging");
	fs.mkdirSync(stagingDir);
	stageAppDirectory({ source: src, stagingDir, rootName });
	return stagingDir;
}

describe("tarPathFrom", () => {
	it("prefixes ./ to a bare name so a colon is never read as a remote host", () => {
		expect(tarPathFrom(tmpRoot, path.join(tmpRoot, "foo:bar.tgz"))).toBe("./foo:bar.tgz");
		expect(tarPathFrom(tmpRoot, path.join(tmpRoot, "-dash.tgz"))).toBe("./-dash.tgz");
	});

	it("keeps a nested path as is, with forward slashes", () => {
		expect(tarPathFrom(tmpRoot, path.join(tmpRoot, "sub", "a.tgz"))).toBe("sub/a.tgz");
	});
});

describe("buildArchive / extractArchive / auditArchiveEntries", () => {
	it("builds into a RELATIVE outPath (cwd differs from the archive's folder)", () => {
		const stagingDir = stage("demo");
		const outAbs = path.join(tmpRoot, "out", "demo.tgz");
		fs.mkdirSync(path.dirname(outAbs));
		const outRel = path.relative(process.cwd(), outAbs);
		expect(path.isAbsolute(outRel)).toBe(false);

		buildArchive({ stagingDir, rootName: "demo", outPath: outRel });
		expect(fs.existsSync(outAbs)).toBe(true);
		expect(fs.existsSync(`${outAbs}.filelist`)).toBe(false);

		const audit = auditArchiveEntries(outRel, "demo");
		expect(audit.errors).toEqual([]);
		const dest = path.join(tmpRoot, "dest");
		extractArchive(outRel, dest);
		expect(fs.existsSync(path.join(dest, "demo", "manifest.json"))).toBe(true);
	});

	// A colon is not a legal filename character on Windows.
	it.skipIf(process.platform === "win32")(
		"handles an archive whose name has a colon (GNU tar would read foo: as a host)",
		() => {
			const stagingDir = stage("demo");
			const outPath = path.join(tmpRoot, "foo:bar.tgz");
			buildArchive({ stagingDir, rootName: "demo", outPath });
			expect(fs.existsSync(outPath)).toBe(true);
			expect(auditArchiveEntries(outPath, "demo").errors).toEqual([]);
			const dest = path.join(tmpRoot, "dest2");
			extractArchive(outPath, dest);
			expect(fs.existsSync(path.join(dest, "demo", "manifest.json"))).toBe(true);
		},
	);
});
