/**
 * The house unattended signals (CI, EIGHT_HEADLESS, EIGHT_UNATTENDED) and
 * folder-name safety for out-of-process extensions (#44, 8SO findings 6 and 7).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAllExtensions, loadExtension } from "./loader";
import { enableExtension, startProcessExtension } from "./process";

const FIXTURE = path.join(import.meta.dir, "fixtures", "hello");
const yes = async () => true;
const FLAGS = ["EIGHT_HEADLESS", "EIGHT_UNATTENDED", "CI"];

let root: string;
const saved = { ...process.env };

function install(name = "hello"): string {
	const dir = path.join(root, name);
	fs.cpSync(FIXTURE, dir, { recursive: true });
	return dir;
}

const tty = (v: boolean | undefined) => {
	for (const s of [process.stdin, process.stdout])
		Object.defineProperty(s, "isTTY", { value: v, configurable: true, writable: true });
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-unatt-"));
	for (const k of FLAGS) delete process.env[k];
});
afterEach(() => {
	process.env = { ...saved };
	tty(undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the house unattended signals", () => {
	for (const flag of FLAGS) {
		test(`a terminal plus ${flag}=1 still starts nothing`, async () => {
			const dir = install();
			await enableExtension(dir, "manifest.json", yes);
			process.env[flag] = "1";
			tty(true);
			const [ext] = await loadAllExtensions(root);
			expect(ext.status).toBe("disabled");
			expect(ext.error).toBe("disabled (unattended)");
			expect(fs.existsSync(path.join(dir, "started"))).toBe(false);
			await expect(startProcessExtension(dir)).rejects.toThrow("unattended");
			// The default prompt answers No without asking.
			fs.rmSync(path.join(dir, ".enabled"));
			expect(await enableExtension(dir)).toBe(false);
			expect(fs.existsSync(path.join(dir, ".enabled"))).toBe(false);
		});
	}

	test("a terminal and none of the flags does start it", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		tty(true);
		const [ext] = await loadAllExtensions(root);
		try {
			expect(ext.status).toBe("loaded");
			expect(fs.existsSync(path.join(dir, "started"))).toBe(true);
		} finally {
			ext.close?.();
		}
	});
});

describe("folder names", () => {
	test("a name with a bidi override is neither enabled nor loaded", async () => {
		const dir = install("x‮yp.olleh");
		let asked = false;
		const ask = async () => {
			asked = true;
			return true;
		};
		expect(await enableExtension(dir, "manifest.json", ask)).toBe(false);
		expect(asked).toBe(false);
		// Even a grant written by hand does not load it.
		const bytes = fs.readFileSync(path.join(dir, "manifest.json"));
		fs.writeFileSync(path.join(dir, ".enabled"), createHash("sha256").update(bytes).digest("hex"));
		expect(await loadAllExtensions(root, { attended: true })).toEqual([]);
		const direct = await loadExtension(dir, { attended: true });
		expect(direct.status).toBe("error");
		expect(direct.manifest.name).not.toContain("‮");
		expect(fs.existsSync(path.join(dir, "started"))).toBe(false);
	});
});
