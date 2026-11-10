import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LABEL, type LaneConfig, type Tests, assertNetworkDenied, gateB, gateC, gateS, hashVerify, loadConfig, ptrsHeader, runLane, stage, stampAppend, denyWrap, runDenied } from "./lane";
import { releaseChecks } from "./release";

const HERE = import.meta.dir;
const REF = fs.readFileSync(path.join(HERE, "fixtures/ref/motor-startstop.st"), "utf8");
const TESTS = fs.readFileSync(path.join(HERE, "fixtures/ref/motor-startstop.tests.json"), "utf8");
const FAULTS: { name: string; replace: [string, string][] }[] = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/faults.json"), "utf8")).faults;
const mutate = (src: string, rep: [string, string][]) => rep.reduce((s, [a, b]) => s.replace(a, b), src);
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "plc-lane-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mkCfg = (n: string): LaneConfig => loadConfig({ quarantineDir: path.join(tmp, n), publishPaths: [path.join(tmp, n, "out")] });

const hasIec2c = spawnSync("sh", ["-c", "command -v iec2c"]).status === 0;
const SKIP = "iec2c (matiec) not installed here: real-path Gate A/B/C tests skipped";
if (!hasIec2c) console.warn(`factory-plc: ${SKIP}`);

describe("Gate S", () => {
	test("reference passes", () => expect(gateS(REF)).toEqual([]));
	test("double-driven output and unbounded loop are rejected", () => {
		for (const n of ["double-driven-output", "unbounded-loop-in-scan"]) {
			const f = FAULTS.find((x) => x.name === n)!;
			expect(gateS(mutate(REF, f.replace)).length).toBeGreaterThan(0);
		}
	});
	test("FOR with constant bounds ok, variable bound rejected, REPEAT rejected, recursion rejected, non-ASCII rejected", () => {
		expect(gateS("PROGRAM p VAR x : INT; END_VAR FOR i := 0 TO 9 BY 1 DO x := x + 1; END_FOR; END_PROGRAM")).toEqual([]);
		expect(gateS("PROGRAM p VAR n : INT; END_VAR FOR i := 0 TO n DO x := 1; END_FOR; END_PROGRAM").join()).toContain("non-constant");
		expect(gateS("PROGRAM p REPEAT x := 1; UNTIL TRUE END_REPEAT; END_PROGRAM").join()).toContain("WHILE or REPEAT");
		expect(gateS("FUNCTION f : INT f := f(1); END_FUNCTION").join()).toContain("recursion");
		expect(gateS("PROGRAM p (* café *) END_PROGRAM").join()).toContain("non-ASCII");
	});
	test("a loop inside a comment is not a loop", () => expect(gateS("PROGRAM p (* WHILE x DO *) END_PROGRAM")).toEqual([]));
	test("every seeded fault changes the program text", () => {
		expect(FAULTS.length).toBeGreaterThanOrEqual(12);
		for (const f of FAULTS) for (const [a] of f.replace) { expect(REF.includes(a)).toBe(true); expect(mutate(REF, f.replace)).not.toBe(REF); }
	});
});

describe("hash-verify and the stamp", () => {
	const cfg = mkCfg("tamper");
	const dir = stage(cfg, "ref", REF, TESTS, "Rishi");
	test("fresh stamp verifies and carries the label", () => {
		expect(hashVerify(dir).hash).toHaveLength(64);
		expect(fs.readFileSync(path.join(dir, "stamp.log"), "utf8")).toContain(LABEL);
	});
	test("one byte edit of the program is refused", () => {
		const p = path.join(dir, "program.st"); const orig = fs.readFileSync(p);
		fs.writeFileSync(p, Buffer.concat([orig, Buffer.from(" ")]));
		expect(() => hashVerify(dir)).toThrow(/refusing/);
		expect(runLane(cfg, dir)).rejects.toThrow(/refusing/);
		fs.writeFileSync(p, orig); expect(() => hashVerify(dir)).not.toThrow();
	});
	test("edited, truncated-to-nothing or deleted stamp is refused", () => {
		const s = path.join(dir, "stamp.log"); const orig = fs.readFileSync(s, "utf8");
		fs.writeFileSync(s, orig.replace("Rishi", "Artale")); expect(() => hashVerify(dir)).toThrow(/chain broken/);
		fs.writeFileSync(s, ""); expect(() => hashVerify(dir)).toThrow(/refusing/);
		fs.rmSync(s); expect(() => hashVerify(dir)).toThrow(/missing/);
		fs.writeFileSync(s, orig);
	});
	test("restaging an existing program is refused; writes outside quarantine are refused", () => {
		expect(() => stage(cfg, "ref", REF, TESTS, "Rishi")).toThrow(/already stamped/);
		expect(() => stage(cfg, "../escape", REF, TESTS, "Rishi")).toThrow(/bad program name/);
		expect(runLane(cfg, tmp)).rejects.toThrow(/not in quarantine/);
	});
});

describe("promotion is blocked technically", () => {
	test("every publish path in lane.json is inside quarantine", () => {
		const c = loadConfig();
		for (const p of c.publishPaths) expect(p.startsWith(c.quarantineDir + path.sep)).toBe(true);
	});
	test("lane.ts has no route out: no release import, no copy or rename", () => {
		const src = fs.readFileSync(path.join(HERE, "lane.ts"), "utf8");
		expect(src).not.toMatch(/from "\.\/release"/);
		expect(src).not.toMatch(/copyFile|renameSync|cpSync|symlinkSync/);
	});
	test("factory-release run for real with stdin not a terminal exits non-zero and moves nothing", () => {
		const dest = path.join(tmp, "released-nope");
		const r = spawnSync("bun", [path.join(HERE, "release.ts"), path.join(tmp, "tamper", "ref"), "--reviewer", "Artale", "--dest", dest], { input: "y\n", encoding: "utf8" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("terminal");
		expect(fs.existsSync(dest)).toBe(false);
	});
	describe("releaseChecks", () => {
		const cfg = mkCfg("rel");
		const dir = stage(cfg, "ref", REF, TESTS, "Rishi");
		const env = {};
		test("no terminal, unattended env", () => {
			expect(() => releaseChecks(cfg, dir, "Artale", false, env)).toThrow(/terminal/);
			expect(() => releaseChecks(cfg, dir, "Artale", true, { CI: "1" })).toThrow(/unattended/);
			expect(() => releaseChecks(cfg, dir, "Artale", true, { UNATTENDED: "true" })).toThrow(/unattended/);
		});
		test("a program with no passed gates cannot be released", () => expect(() => releaseChecks(cfg, dir, "Artale", true, env)).toThrow(/gate S has not passed/));
		test("a failed gate blocks, a passed set releases, reviewer rules hold", () => {
			const { hash } = hashVerify(dir);
			for (const g of ["S", "A", "B"]) stampAppend(dir, { event: "gate", hash, gate: g, ok: true });
			stampAppend(dir, { event: "gate", hash, gate: "C", ok: false });
			expect(() => releaseChecks(cfg, dir, "Artale", true, env)).toThrow(/gate C/);
			stampAppend(dir, { event: "gate", hash, gate: "C", ok: true });
			expect(releaseChecks(cfg, dir, "Artale", true, env)).toBe(hash);
			expect(() => releaseChecks(cfg, dir, "Rishi", true, env)).toThrow(/not named/);
			const self = mkCfg("rel2"); self.reviewers = ["Rishi"];
			const d2 = stage(self, "ref", REF, TESTS, "Rishi"); const h2 = hashVerify(d2).hash;
			for (const g of ["S", "A", "B", "C"]) stampAppend(d2, { event: "gate", hash: h2, gate: g, ok: true });
			expect(() => releaseChecks(self, d2, "Rishi", true, env)).toThrow(/author cannot be the reviewer/);
		});
		test("a gate recorded against an older hash does not carry over", () => {
			const c = mkCfg("rel3"); const d = stage(c, "ref", REF, TESTS, "Rishi");
			for (const g of ["S", "A", "B", "C"]) stampAppend(d, { event: "gate", hash: "f".repeat(64), gate: g, ok: true });
			expect(() => releaseChecks(c, d, "Artale", true, env)).toThrow(/gate S has not passed/);
		});
	});
});

// Harness protocol, TS gates and network probe against a HAND-WRITTEN stub (fixtures/stub). This is not Gate A
// and not evidence about matiec output; it proves harness.c compiles, speaks its protocol, and that Gates B and C
// catch the faults the stub can express.
describe("harness and gates against the hand-written stub", () => {
	const stub = path.join(HERE, "fixtures/stub");
	const tests = JSON.parse(TESTS) as Tests;
	const header = ptrsHeader(fs.readFileSync(path.join(stub, "LOCATED_VARIABLES.h"), "utf8"));
	const plain = (c: string, a: string[], input?: string) => { const r = spawnSync(c, a, { input, encoding: "utf8" }); return { code: r.status ?? -1, out: r.stdout, err: r.stderr }; };
	const build = (name: string, defs: string[] = []) => {
		const d = path.join(tmp, "stub-" + name); fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, "ptrs.h"), header as string);
		const out = path.join(d, "harness");
		const r = spawnSync("cc", ["-w", ...defs, "-I", d, "-I", stub, "-o", out, path.join(HERE, "harness.c"), path.join(stub, "Config0.c")], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr);
		return out;
	};
	test("ptrsHeader maps located names and refuses non-BOOL", () => {
		expect(header).toContain('"IX0.0"'); expect(header).toContain('"QX0.0"');
		expect(ptrsHeader("__LOCATED_VAR(INT,__IW0_0,I,W,0,0)")).toEqual({ error: "slice 1 supports BOOL located variables only" });
	});
	test("reference translation passes Gate B and Gate C", () => {
		const bin = build("ok");
		expect(gateB(bin, tests, plain)).toEqual([]);
		expect(gateC(bin, tests, plain)).toEqual([]);
	});
	for (const [def, caught] of [["FAULT_NOESTOP", "estop"], ["FAULT_LATE", "estop"], ["FAULT_RESTART", "estop release"]] as const)
		test(`${def} is caught by Gate C`, () => {
			const bin = build(def, [`-D${def}`]);
			expect(gateC(bin, tests, plain).join("\n")).toContain(caught);
		});
	test("the probe detects an open network (control for the denial test)", async () => {
		const bin = build("probe"); let hits = 0;
		const srv = net.createServer((s) => { hits++; s.destroy(); });
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
		const port = (srv.address() as net.AddressInfo).port;
		const r = spawnSync(bin, ["--probe", String(port)]);
		await new Promise((r) => setTimeout(r, 100)); srv.close();
		expect(r.status).toBe(3); expect(hits).toBe(1);
	});
	const canDeny = (() => { try { const [c, a] = denyWrap("true", []); return spawnSync(c, a).status === 0; } catch { return false; } })();
	test.skipIf(!canDeny)("denied runs pass the probe and a connect attempt is blocked", async () => {
		const bin = build("deny");
		await assertNetworkDenied(bin);
		expect(runDenied("true", []).code).toBe(0);
	});
	test("if the wrapper cannot deny, the runner refuses rather than running open", async () => {
		if (canDeny) return;
		await expect(assertNetworkDenied(build("nodeny"))).rejects.toThrow(/network not denied|refusing/);
	});
});

// The real path. Needs matiec. Skips cleanly when absent.
describe.skipIf(!hasIec2c)("real path: matiec, every seeded fault, reference", () => {
	test("reference passes Gates S, A, B, C", async () => {
		const r = await runLane(mkCfg("real"), stage(mkCfg("real"), "ref", REF, TESTS, "Rishi"));
		expect(r.results.filter((x) => !x.ok)).toEqual([]);
		expect(r.ok).toBe(true);
	}, 600_000);
	for (const f of FAULTS)
		test(`seeded fault ${f.name} is caught`, async () => {
			const cfg = mkCfg("fault-" + f.name);
			const r = await runLane(cfg, stage(cfg, "p", mutate(REF, f.replace), TESTS, "Rishi"));
			expect(r.ok).toBe(false);
		}, 600_000);
});
