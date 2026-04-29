import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { auditCapabilities, checkSize, dirSize } from "./checks";
import type { AppManifest } from "./manifest";

const baseManifest: AppManifest = {
	manifestVersion: 1,
	name: "demo",
	version: "1.0.0",
	author: "Tester",
	description: "demo",
	license: "Apache-2.0",
	entry: "src/index.ts",
	capabilities: [],
};

describe("auditCapabilities", () => {
	it("passes when no dangerous capability is declared", () => {
		const r = auditCapabilities(baseManifest);
		expect(r.level).toBe("ok");
	});

	it("blocks dangerous capability without override", () => {
		const r = auditCapabilities({ ...baseManifest, capabilities: ["dangerous"] });
		expect(r.level).toBe("error");
	});

	it("warns but allows dangerous capability with override", () => {
		const r = auditCapabilities(
			{ ...baseManifest, capabilities: ["dangerous"] },
			{ allowDangerous: true },
		);
		expect(r.level).toBe("warn");
	});
});

describe("checkSize / dirSize", () => {
	it("passes under the limit", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-checks-"));
		try {
			const file = path.join(tmp, "fake.tar.gz");
			fs.writeFileSync(file, Buffer.alloc(1024));
			const r = checkSize(file, { maxBytes: 4096 });
			expect(r.level).toBe("ok");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("fails over the limit", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-checks-"));
		try {
			const file = path.join(tmp, "fake.tar.gz");
			fs.writeFileSync(file, Buffer.alloc(8192));
			const r = checkSize(file, { maxBytes: 4096 });
			expect(r.level).toBe("error");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("dirSize sums every file in a tree", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-checks-dir-"));
		try {
			fs.mkdirSync(path.join(tmp, "a"), { recursive: true });
			fs.writeFileSync(path.join(tmp, "a", "1.txt"), "abcde");
			fs.writeFileSync(path.join(tmp, "b.txt"), "xyz");
			expect(dirSize(tmp)).toBe(8);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
