import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childInvocation, materializeTui } from "./embedded-bundle";

const posix = process.platform !== "win32";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "emb-"));
const BUNDLE = Buffer.from("console.log('tui-ok');\n" + "x".repeat(2048));

describe("materializeTui", () => {
	test("writes a private, hash-named copy", () => {
		const dir = path.join(tmp(), "cache");
		const f = materializeTui(BUNDLE, dir);
		expect(path.basename(f)).toMatch(/^tui-[0-9a-f]{16}\.js$/);
		expect(fs.readFileSync(f).equals(BUNDLE)).toBe(true);
		if (posix) {
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
			expect(fs.statSync(f).mode & 0o777).toBe(0o600);
		}
		expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("a same-size tampered cache file is rewritten on the next launch", () => {
		const dir = path.join(tmp(), "cache");
		const f = materializeTui(BUNDLE, dir);
		const evil = Buffer.from(BUNDLE);
		evil[3] ^= 0xff; // same length, different bytes
		fs.writeFileSync(f, evil);
		expect(materializeTui(BUNDLE, dir)).toBe(f);
		expect(fs.readFileSync(f).equals(BUNDLE)).toBe(true);
	});

	test("a symlink planted at the target is replaced, its destination untouched", () => {
		if (!posix) return;
		const dir = path.join(tmp(), "cache");
		const f = materializeTui(BUNDLE, dir);
		const victim = path.join(tmp(), "victim.txt");
		fs.writeFileSync(victim, "keep");
		fs.rmSync(f);
		fs.symlinkSync(victim, f);
		materializeTui(BUNDLE, dir);
		expect(fs.lstatSync(f).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(victim, "utf8")).toBe("keep");
		expect(fs.readFileSync(f).equals(BUNDLE)).toBe(true);
	});

	test("a cache dir that is a symlink is refused", () => {
		if (!posix) return;
		const real = tmp();
		const link = path.join(tmp(), "cache");
		fs.symlinkSync(real, link);
		expect(() => materializeTui(BUNDLE, link)).toThrow();
		expect(fs.readdirSync(real)).toEqual([]);
	});

	test("a loose-permission cache dir is tightened to 0700", () => {
		if (!posix) return;
		const dir = path.join(tmp(), "cache");
		fs.mkdirSync(dir, { mode: 0o777 });
		fs.chmodSync(dir, 0o777);
		materializeTui(BUNDLE, dir);
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});

	test("prunes older bundles and stale temp files, keeps unrelated files", () => {
		const dir = path.join(tmp(), "cache");
		fs.mkdirSync(dir, { recursive: true });
		const old = path.join(dir, "tui-0123456789abcdef.js");
		const staleTmp = path.join(dir, "tui-0123456789abcdef.js.0123456789abcdef.tmp");
		const other = path.join(dir, "notes.txt");
		for (const p of [old, staleTmp, other]) fs.writeFileSync(p, "old");
		const past = new Date(Date.now() - 3 * 3600 * 1000);
		fs.utimesSync(staleTmp, past, past);
		const f = materializeTui(BUNDLE, dir);
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(staleTmp)).toBe(false);
		expect(fs.existsSync(other)).toBe(true);
		expect(fs.existsSync(f)).toBe(true);
	});

	test("repeated launches (concurrent first runs) converge on one verified file", () => {
		const dir = path.join(tmp(), "cache");
		const paths = Array.from({ length: 8 }, () => materializeTui(BUNDLE, dir));
		expect(new Set(paths).size).toBe(1);
		expect(fs.readdirSync(dir).filter((n) => n.startsWith("tui-"))).toHaveLength(1);
	});
});

describe("childInvocation: a hostile working directory", () => {
	// bun test runs on Bun, so process.execPath is a Bun CLI, the same role the
	// compiled binary plays under BUN_BE_BUN=1.
	test("bunfig.toml preload and .env in cwd load nothing", () => {
		const cache = path.join(tmp(), "cache");
		const cwd = tmp();
		const marker = path.join(tmp(), "PWNED");
		fs.writeFileSync(path.join(cwd, "evil.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
		fs.writeFileSync(path.join(cwd, "bunfig.toml"), 'preload = ["./evil.js"]\n');
		fs.writeFileSync(path.join(cwd, ".env"), "HOSTILE=from-dotenv\n");
		const probe = path.join(tmp(), "probe.js");
		fs.writeFileSync(probe, "console.log(JSON.stringify({h: process.env.HOSTILE ?? null, a: process.argv.slice(2)}));");

		// Control: plain bun in the same cwd does honour both, so the test can fail.
		const control = Bun.spawnSync([process.execPath, "run", probe], { cwd, env: { ...process.env } });
		expect(JSON.parse(control.stdout.toString().trim().split("\n").pop() as string).h).toBe("from-dotenv");
		expect(fs.existsSync(marker)).toBe(true);
		fs.rmSync(marker);

		const inv = childInvocation(process.execPath, probe, ["--resume", "x"], cache);
		const r = Bun.spawnSync([inv.command, ...inv.args], { cwd, env: inv.env });
		const out = JSON.parse(r.stdout.toString().trim().split("\n").pop() as string);
		expect(out.h).toBeNull();
		expect(out.a).toEqual(["--resume", "x"]);
		expect(fs.existsSync(marker)).toBe(false);
	});

	test("the TUI entry strips BUN_BE_BUN before any subprocess can inherit it", () => {
		const r = Bun.spawnSync(
			[process.execPath, "-e", `import "${path.resolve(import.meta.dir, "strip-bun-be-bun.ts")}"; console.log(String(process.env.BUN_BE_BUN));`],
			{ env: { ...process.env, BUN_BE_BUN: "1" } },
		);
		expect(r.stdout.toString().trim()).toBe("undefined");
	});
});
