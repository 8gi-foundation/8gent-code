/**
 * 8SO review of #4889: what the durable run keeps on disk, what a second process can do to the
 * same run, and what the flag-off path loads. Real files, a real SQLite ledger, the real CLI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { EffectLedger } from "./ledger.js";
import { RUN_ID_RE, defaultRunDb, preparePrivateFile, resolveInside } from "./storage.js";
import { type DurableDeps, durableTool } from "./tools.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const fresh = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "durable-hard-"));
	roots.push(d);
	return d;
};
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("the run store is private", () => {
	test("file, wal and shm are 0600 and the folder it makes is 0700", () => {
		const dir = path.join(fresh(), "runs");
		const file = path.join(dir, "r1.sqlite");
		const ledger = new EffectLedger(file);
		ledger.start("1:c1", "t");
		expect(mode(dir)).toBe(0o700);
		expect(mode(file)).toBe(0o600);
		for (const side of ["-wal", "-shm"])
			if (fs.existsSync(file + side)) expect(mode(file + side)).toBe(0o600);
		ledger.close();
	});

	test("a loose existing file is tightened; a link at the file name is refused", () => {
		const dir = fresh();
		const file = path.join(dir, "loose.sqlite");
		fs.writeFileSync(file, "", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		preparePrivateFile(file);
		expect(mode(file)).toBe(0o600);
		const victim = path.join(dir, "victim");
		fs.writeFileSync(victim, "precious", { mode: 0o644 });
		fs.symlinkSync(victim, path.join(dir, "linked.sqlite"));
		expect(() => preparePrivateFile(path.join(dir, "linked.sqlite"))).toThrow();
		expect(fs.readFileSync(victim, "utf8")).toBe("precious");
		expect(mode(victim)).toBe(0o644);
	});

	test("an existing folder is never re-moded, and one others can write to is refused", () => {
		const base = fresh();
		const shared = path.join(base, "shared");
		fs.mkdirSync(shared, { mode: 0o755 });
		fs.chmodSync(shared, 0o755);
		preparePrivateFile(path.join(shared, "a.sqlite"));
		expect(mode(shared)).toBe(0o755); // `8gent durable-run <existing dir>` does not chmod it
		const open = path.join(base, "open");
		fs.mkdirSync(open, { mode: 0o777 });
		fs.chmodSync(open, 0o777);
		expect(() => preparePrivateFile(path.join(open, "a.sqlite"))).toThrow(/writable by others/);
	});

	test("a run id is a file name and nothing else", () => {
		for (const bad of [
			"../x",
			"a/b",
			"..",
			"",
			"x".repeat(65),
			"a b",
			"a\u0000b",
			"~",
			"a.sqlite/../../b",
		]) {
			expect(RUN_ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
			expect(() => defaultRunDb(bad)).toThrow(/valid run id/);
		}
		expect(defaultRunDb("run_01-A")).toMatch(/runs[\\/]run_01-A\.sqlite$/);
	});
});

describe("two processes on one run cannot both run an effect", () => {
	const api = { conversationId: 7, callId: "c1" } as never;
	const ctx = {} as never;
	function toolOver(file: string, spec: object, runs: { n: number }) {
		const ledger = new EffectLedger(file);
		const deps: DurableDeps = { ledger, gate: async () => ({ run: true }) };
		const tool = durableTool(
			{
				name: "t",
				description: "t",
				parameters: Type.Object({}),
				...spec,
				run: async () => {
					runs.n++;
					return "ran";
				},
			} as never,
			deps,
		);
		return { tool, ledger };
	}

	test("start() is a claim: one caller wins, the other is told it lost", () => {
		const file = path.join(fresh(), "l.sqlite");
		const a = new EffectLedger(file);
		const b = new EffectLedger(file); // a second process, same file
		expect(a.start("7:c1", "t")).toBe(true);
		expect(b.start("7:c1", "t")).toBe(false);
		a.close();
		b.close();
	});

	test("a tool the target does not dedupe is not run when another process holds the claim", async () => {
		const file = path.join(fresh(), "l.sqlite");
		const other = new EffectLedger(file);
		other.start("7:c1", "t"); // the other process claimed the call and is mid-effect
		const runs = { n: 0 };
		const { tool, ledger } = toolOver(file, { replay: "once", idempotentByKey: false }, runs);
		const r = (await tool.execute({}, api, ctx)) as { isError?: boolean };
		expect(runs.n).toBe(0);
		expect(r.isError).toBe(true);
		ledger.close();
		other.close();
	});

	test("two concurrent attempts through the real tool: the effect runs once", async () => {
		const file = path.join(fresh(), "l.sqlite");
		const runs = { n: 0 };
		const a = toolOver(file, { replay: "once", idempotentByKey: false }, runs);
		const b = toolOver(file, { replay: "once", idempotentByKey: false }, runs);
		await Promise.all([a.tool.execute({}, api, ctx), b.tool.execute({}, api, ctx)]);
		expect(runs.n).toBe(1);
		a.ledger.close();
		b.ledger.close();
	});

	test("a tool the target dedupes by key may run alongside the claim", async () => {
		const file = path.join(fresh(), "l.sqlite");
		const other = new EffectLedger(file);
		other.start("7:c1", "t");
		const runs = { n: 0 };
		const { tool, ledger } = toolOver(file, { replay: "once", idempotentByKey: true }, runs);
		await tool.execute({}, api, ctx);
		expect(runs.n).toBe(1);
		ledger.close();
		other.close();
	});
});

describe("flag off loads nothing", () => {
	test("the flag module has no imports", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "flag.ts"), "utf8");
		expect(src).not.toMatch(/^\s*import\s/m);
		expect(src).not.toMatch(/\brequire\(|import\(/);
	});

	test("bin/8gent.ts reads the flag from that module, before importing the run", () => {
		const src = fs.readFileSync(path.join(ROOT, "bin", "8gent.ts"), "utf8");
		const at = src.indexOf('case "durable-run"');
		const block = src.slice(at, src.indexOf('case "stack"', at));
		expect(block.indexOf("durable-run/flag.ts")).toBeGreaterThan(-1);
		expect(block.indexOf("durable-run/flag.ts")).toBeLessThan(block.indexOf("durable-run/demo.ts"));
		expect(block).not.toContain("durable-run/run.ts");
		// and no other part of the CLI imports the run statically
		const top = src.slice(0, src.indexOf("async function main()"));
		expect(top).not.toContain("durable-run");
	});

	test("8gent durable-run without the flag refuses, exits 1 and writes nothing", async () => {
		const dir = path.join(fresh(), "never");
		const proc = Bun.spawn(["bun", path.join(ROOT, "bin/8gent.ts"), "durable-run", dir], {
			cwd: ROOT,
			env: { ...process.env, EIGHT_DURABLE_RUN: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const err = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(1);
		expect(err).toContain("EIGHT_DURABLE_RUN=1");
		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("write_file stays inside the run's out folder", () => {
	test("resolveInside refuses a path above the folder, an absolute one, and one through a link", () => {
		const base = fresh();
		const out = path.join(base, "out");
		fs.mkdirSync(path.join(out, "sub"), { recursive: true });
		const elsewhere = path.join(base, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.symlinkSync(elsewhere, path.join(out, "linkdir"));
		for (const bad of [
			"../x",
			"../../etc/passwd",
			"sub/../../x",
			"/etc/passwd",
			path.join(base, "elsewhere", "x"),
			"linkdir/x",
			"linkdir/new/deeper/x",
			"..",
			"",
		])
			expect(() => resolveInside(out, bad), JSON.stringify(bad)).toThrow();
		const real = fs.realpathSync(out);
		expect(resolveInside(out, "notes.txt")).toBe(path.join(real, "notes.txt"));
		expect(resolveInside(out, "sub/deeper/notes.txt")).toBe(
			path.join(real, "sub", "deeper", "notes.txt"),
		);
	});

	test("the demo's write_file resolves its path through it", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "demo.ts"), "utf8");
		const at = src.indexOf('name: "write_file"');
		const block = src.slice(at, src.indexOf('name: "telegram_send"', at));
		expect(block).toContain("resolveInside(outDir, a.path)");
		expect(block).not.toMatch(/path\.join\(dir, "out", a\.path\)/);
	});
});
