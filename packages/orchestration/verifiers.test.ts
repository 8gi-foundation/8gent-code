/**
 * Tests for verifiers.ts - the real, pluggable quality gates.
 *
 * Kept FAST and hermetic: no real tsc run and no real network in any assertion
 * we depend on. File checks use a temp dir; the http check uses a stubbed fetch.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BuildUnit, VerifierFinding, VerifyInput } from "./pipeline-contracts.js";
import {
	fileExistsVerifier,
	httpVerifier,
	makeFilesWrittenVerifier,
	verifierFindingToObstacle,
} from "./verifiers.js";

function makeUnit(path: string): BuildUnit {
	return { id: path, path, kind: "other", spec: "test unit", dependsOn: [] };
}

describe("fileExistsVerifier", () => {
	test("non-empty file at unit.path -> ok", async () => {
		const dir = mkdtempSync(join(tmpdir(), "verif-"));
		try {
			writeFileSync(join(dir, "real.txt"), "content");
			const input: VerifyInput = { workingDirectory: dir, unit: makeUnit("real.txt") };
			const f = await fileExistsVerifier.verify(input);
			expect(f.ok).toBe(true);
			expect(f.severity).toBe("trivial");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing file -> ok:false severe missing-file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "verif-"));
		try {
			const input: VerifyInput = { workingDirectory: dir, unit: makeUnit("ghost.txt") };
			const f = await fileExistsVerifier.verify(input);
			expect(f.ok).toBe(false);
			expect(f.severity).toBe("severe");
			expect(f.type).toBe("missing-file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("makeFilesWrittenVerifier", () => {
	test("one existing + one missing path -> ok:false", async () => {
		const dir = mkdtempSync(join(tmpdir(), "verif-"));
		try {
			writeFileSync(join(dir, "here.ts"), "export const x = 1;");
			const v = makeFilesWrittenVerifier(["here.ts", "gone.ts"]);
			const f = await v.verify({ workingDirectory: dir });
			expect(f.ok).toBe(false);
			expect(f.severity).toBe("severe");
			expect(f.type).toBe("missing-file");
			expect(f.detail).toContain("gone.ts");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("all paths present -> ok", async () => {
		const dir = mkdtempSync(join(tmpdir(), "verif-"));
		try {
			writeFileSync(join(dir, "a.ts"), "a");
			writeFileSync(join(dir, "b.ts"), "b");
			const v = makeFilesWrittenVerifier(["a.ts", "b.ts"]);
			const f = await v.verify({ workingDirectory: dir });
			expect(f.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("httpVerifier", () => {
	test("no url -> ok trivial no-url", async () => {
		const f = await httpVerifier.verify({ workingDirectory: "/tmp" });
		expect(f.ok).toBe(true);
		expect(f.severity).toBe("trivial");
		expect(f.type).toBe("no-url");
	});

	test("stubbed 500 response -> ok:false severe http-error", async () => {
		const original = global.fetch;
		global.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
		try {
			const f = await httpVerifier.verify({
				workingDirectory: "/tmp",
				url: "http://localhost:9/down",
			});
			expect(f.ok).toBe(false);
			expect(f.severity).toBe("severe");
			expect(f.type).toBe("http-error");
		} finally {
			global.fetch = original;
		}
	});
});

describe("verifierFindingToObstacle", () => {
	test("round-trips type + severity", () => {
		const finding: VerifierFinding = {
			ok: false,
			severity: "moderate",
			type: "compile-timeout",
			detail: "slow",
		};
		const ob = verifierFindingToObstacle(finding);
		expect(ob.type).toBe("compile-timeout");
		expect(ob.severity).toBe("moderate");
	});
});
