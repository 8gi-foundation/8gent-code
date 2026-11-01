import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunShim, buildSpawnOptions, spawn, spawnSync, which } from "./bun-shim";
import { Database, hasSeveralStatements } from "./bun-sqlite";

describe("which", () => {
	test("skips empty and relative PATH entries, needs an absolute executable", () => {
		const cwd = mkdtempSync(join(tmpdir(), "which-"));
		const abs = join(cwd, "bin");
		mkdirSync(abs);
		writeFileSync(join(cwd, "fakebin"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(abs, "plain"), "x", { mode: 0o644 });
		writeFileSync(join(abs, "exe"), "#!/bin/sh\n", { mode: 0o755 });
		const prev = process.cwd();
		process.chdir(cwd);
		try {
			expect(which("fakebin", { PATH: "/usr/bin::/bin" })).toBeNull();
			expect(which("fakebin", { PATH: ".:/usr/bin" })).toBeNull();
			expect(which("plain", { PATH: abs })).toBeNull(); // no exec bit
			expect(which("exe", { PATH: abs })).toBe(join(abs, "exe"));
		} finally {
			process.chdir(prev);
		}
		chmodSync(join(abs, "plain"), 0o755);
		expect(which("plain", { PATH: abs })).toBe(join(abs, "plain"));
	});
});

describe("spawn", () => {
	test("passes windowsHide, windowsVerbatimArguments, timeout and killSignal through", () => {
		const o = buildSpawnOptions(
			{
				cwd: "/x",
				windowsHide: true,
				windowsVerbatimArguments: true,
				timeout: 5,
				killSignal: "SIGKILL",
			},
			["ignore", "pipe", "pipe"],
		);
		expect(o.windowsHide).toBe(true);
		expect(o.windowsVerbatimArguments).toBe(true);
		expect(o.timeout).toBe(5);
		expect(o.killSignal).toBe("SIGKILL");
		expect(o.cwd).toBe("/x");
	});
	test("a missing binary throws ENOENT like Bun, sync and async", () => {
		expect(() => spawn(["definitely-not-a-real-binary-xyz"])).toThrow(/not found/);
		expect(() => spawnSync(["definitely-not-a-real-binary-xyz"])).toThrow(/not found/);
		try {
			spawn(["definitely-not-a-real-binary-xyz"]);
		} catch (e) {
			expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
		}
	});
	test("honours timeout", async () => {
		const t0 = Date.now();
		const p = spawn(["sleep", "5"], { timeout: 150, stdout: "ignore", stderr: "ignore" });
		await p.exited;
		expect(Date.now() - t0).toBeLessThan(3000);
	});
	test("Bun.stdin has stream/text/json", () => {
		expect(typeof BunShim.stdin.stream).toBe("function");
		expect(typeof BunShim.stdin.text).toBe("function");
		expect(typeof BunShim.stdin.json).toBe("function");
	});
});

describe("sqlite adapter semantics", () => {
	test("nested transaction() uses savepoints: inner failure rolls back only the inner work", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (n INTEGER)");
		const ins = db.query("INSERT INTO t VALUES (?)");
		const inner = db.transaction((n: number) => {
			ins.run(n);
			throw new Error("inner");
		});
		const outer = db.transaction(() => {
			ins.run(1);
			try {
				inner(2);
			} catch {}
			ins.run(3);
		});
		outer();
		expect(db.query("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
		db.close();
	});
	test("db.run with several statements runs them all; with params it throws", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO a VALUES (1);");
		expect(db.query("SELECT count(*) AS n FROM a").get()).toEqual({ n: 1 });
		expect(
			db.query("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('a','b')").get(),
		).toEqual({ n: 2 });
		expect(() => db.run("INSERT INTO a VALUES (?); INSERT INTO a VALUES (?)", 1, 2)).toThrow(
			/several statements/,
		);
		expect(db.run("INSERT INTO a VALUES (?)", 5).changes).toBe(1);
		db.close();
	});
	test("hasSeveralStatements ignores trailing semicolons, strings and comments", () => {
		expect(hasSeveralStatements("SELECT 1;")).toBe(false);
		expect(hasSeveralStatements("SELECT ';x'")).toBe(false);
		expect(hasSeveralStatements("SELECT 1 -- a; b\n")).toBe(false);
		expect(hasSeveralStatements("SELECT 1; SELECT 2")).toBe(true);
	});
});
