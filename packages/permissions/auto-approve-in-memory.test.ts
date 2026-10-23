import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "./index";

const dirs: string[] = [];
const fresh = () => {
	const d = mkdtempSync(join(tmpdir(), "auto-approve-"));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("autoApprove is per process (#4817)", () => {
	test("manager A sets --yes, a fresh manager B loads false", () => {
		const file = join(fresh(), "permissions.json");
		const a = new PermissionManager(file);
		a.setAutoApprove(true);
		expect(a.getConfig().autoApprove).toBe(true);
		a.allowPattern("make *");
		expect(new PermissionManager(file).getConfig().autoApprove).toBe(false);
	});

	test("a file that already says true loads as false and is rewritten once", () => {
		const file = join(fresh(), "permissions.json");
		writeFileSync(
			file,
			JSON.stringify({ autoApprove: true, allowedPatterns: ["x *"], deniedPatterns: [] }),
		);
		expect(new PermissionManager(file).getConfig().autoApprove).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8")).autoApprove).toBe(false);
	});

	test("other keys are preserved", () => {
		const file = join(fresh(), "permissions.json");
		writeFileSync(
			file,
			JSON.stringify({
				autoApprove: true,
				allowedPatterns: ["x *"],
				deniedPatterns: ["y *"],
				custom: { keep: 1 },
			}),
		);
		const m = new PermissionManager(file);
		expect(m.getConfig().allowedPatterns).toEqual(["x *"]);
		const disk = JSON.parse(readFileSync(file, "utf8"));
		expect(disk.allowedPatterns).toEqual(["x *"]);
		expect(disk.deniedPatterns).toEqual(["y *"]);
		expect(disk.custom).toEqual({ keep: 1 });
	});

	test("the rewrite keeps the file mode and the symlink", () => {
		const d = fresh();
		const real = join(d, "real.json");
		const link = join(d, "permissions.json");
		writeFileSync(
			real,
			JSON.stringify({ autoApprove: true, allowedPatterns: [], deniedPatterns: [] }),
		);
		chmodSync(real, 0o600);
		symlinkSync(real, link);
		new PermissionManager(link);
		expect(statSync(real).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(real, "utf8")).autoApprove).toBe(false);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	test("a file already false is not touched", () => {
		const file = join(fresh(), "permissions.json");
		const body = '{"autoApprove":false,"allowedPatterns":[],"deniedPatterns":[]}';
		writeFileSync(file, body);
		new PermissionManager(file);
		expect(readFileSync(file, "utf8")).toBe(body);
	});

	test("saveConfig keeps symlink and mode, leaves no temp file", () => {
		const d = fresh();
		const real = join(d, "real.json");
		const link = join(d, "permissions.json");
		writeFileSync(
			real,
			JSON.stringify({ allowedPatterns: [], deniedPatterns: ["z *"], autoApprove: false }),
		);
		chmodSync(real, 0o640);
		symlinkSync(real, link);
		const m = new PermissionManager(link);
		m.setAutoApprove(true);
		m.allowPattern("make *");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(statSync(real).mode & 0o777).toBe(0o640);
		const disk = JSON.parse(readFileSync(real, "utf8"));
		expect(disk.autoApprove).toBe(false);
		expect(disk.deniedPatterns).toEqual(["z *"]);
		expect(disk.allowedPatterns).toContain("make *");
		expect(readdirSync(d).sort()).toEqual(["permissions.json", "real.json"]);
	});
});
