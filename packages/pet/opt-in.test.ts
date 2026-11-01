import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { petRequested } from "./opt-in";

const ROOT = join(import.meta.dir, "..", "..");

describe("Lil Eight is off by default", () => {
	test("no flag, no pet", () => {
		expect(petRequested([])).toBe(false);
		expect(petRequested(["--resume"])).toBe(false);
	});
	test("--pet opts in, --no-pet wins", () => {
		expect(petRequested(["--pet"])).toBe(true);
		expect(petRequested(["--pet", "--no-pet"])).toBe(false);
	});
	test("a fresh HOME prints no pet output and no banner", async () => {
		const home = mkdtempSync(join(tmpdir(), "pet-fresh-home-"));
		for (const argv of [["--version"], ["--help"]]) {
			const p = Bun.spawn(["bun", join(ROOT, "bin", "8gent.ts"), ...argv], {
				env: { ...process.env, HOME: home, USERPROFILE: home },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
			await p.exited;
			expect(out).not.toMatch(/\[pet\]|Lil Eight terminal mode/);
			expect(out).not.toMatch(/Never hit usage caps|40%\+ token savings|╔═/);
		}
	});
});
