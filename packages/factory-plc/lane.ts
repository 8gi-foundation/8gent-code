/**
 * PLC Structured Text factory lane, slice 1. Simulation only: there is no code path to hardware.
 * Steps: stage -> hash-verify -> Gate S (static) -> Gate A (matiec) -> Gate B (scan tests) -> Gate C (safety).
 * Everything this module writes lands inside the quarantine directory. Release is release.ts, which this
 * file never imports (a test asserts that). Spec: 8TO r2, 2026-11-10.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = import.meta.dir;
export const LABEL = "simulated, not validated on a machine";

export interface LaneConfig {
	quarantineDir: string;
	publishPaths: string[];
	reviewers: string[];
}
const expand = (p: string) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
export function loadConfig(over: Partial<LaneConfig> = {}): LaneConfig {
	const raw = JSON.parse(fs.readFileSync(path.join(HERE, "lane.json"), "utf8"));
	return {
		quarantineDir: expand(over.quarantineDir ?? raw.quarantineDir),
		publishPaths: (over.publishPaths ?? raw.publishPaths).map(expand),
		reviewers: over.reviewers ?? raw.reviewers,
	};
}
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---- quarantine: the only place this lane may write ----
export function inside(root: string, p: string) {
	const r = path.relative(path.resolve(root), path.resolve(p));
	return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}
function qwrite(cfg: LaneConfig, p: string, data: string | Buffer) {
	if (!inside(cfg.quarantineDir, p)) throw new Error(`refusing to write outside quarantine: ${p}`);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, data);
}

// ---- stamp: append-only, hash-chained (3.2, 3.6) ----
export interface StampLine {
	seq: number; at: string; event: string; hash: string; prev: string; chain: string;
	author?: string; reviewer?: string; gate?: string; ok?: boolean; detail?: string; tools?: Record<string, string>; label?: string;
}
const stampPath = (dir: string) => path.join(dir, "stamp.log");
const chainOf = (prev: string, l: Omit<StampLine, "chain">) => sha256(prev + JSON.stringify(l));

export function stampRead(dir: string): StampLine[] {
	if (!fs.existsSync(stampPath(dir))) throw new Error("stamp missing: refusing");
	const lines = fs.readFileSync(stampPath(dir), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s) as StampLine);
	let prev = "0".repeat(64);
	lines.forEach((l, i) => {
		const { chain, ...rest } = l;
		if (l.seq !== i || l.prev !== prev || chain !== chainOf(prev, rest)) throw new Error(`stamp chain broken at line ${i}: refusing`);
		prev = chain;
	});
	if (!lines.length || lines[0].event !== "stamped") throw new Error("stamp has no stamped line: refusing");
	return lines;
}
export function stampAppend(dir: string, ev: Omit<StampLine, "seq" | "at" | "prev" | "chain">) {
	const old = fs.existsSync(stampPath(dir)) ? stampRead(dir) : [];
	const prev = old.length ? old[old.length - 1].chain : "0".repeat(64);
	const l = { seq: old.length, at: new Date().toISOString(), ...ev, prev };
	fs.appendFileSync(stampPath(dir), JSON.stringify({ ...l, chain: chainOf(prev, l) }) + "\n");
}

/** Step hash-verify (3.2): the program on disk must equal the stamped hash and the stamp chain must hold. */
export function hashVerify(dir: string): { hash: string; author: string; lines: StampLine[] } {
	const lines = stampRead(dir);
	const hash = sha256(fs.readFileSync(path.join(dir, "program.st")));
	if (hash !== lines[0].hash) throw new Error(`program hash ${hash} != stamped ${lines[0].hash}: refusing`);
	return { hash, author: lines[0].author ?? "", lines };
}

/** Stage a program into quarantine and stamp it. Author is recorded here and cannot be the reviewer later. */
export function stage(cfg: LaneConfig, name: string, st: string, tests: string, author: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("bad program name");
	if (!author) throw new Error("author required");
	const dir = path.join(cfg.quarantineDir, name);
	if (fs.existsSync(stampPath(dir))) throw new Error(`${name} already stamped: refusing to restage`);
	qwrite(cfg, path.join(dir, "program.st"), st);
	qwrite(cfg, path.join(dir, "tests.json"), tests);
	qwrite(cfg, path.join(dir, "safety-note.md"), `# ${name}\n\n${LABEL}\n\nAuthor: ${author}\nThis states which checks passed, never that the program is safe to run.\n`);
	stampAppend(dir, { event: "stamped", hash: sha256(st), author, label: LABEL, tools: toolVersions() });
	return dir;
}
function toolVersions() {
	const v = (c: string, a: string[]) => { const r = spawnSync(c, a, { encoding: "utf8" }); return r.error ? "absent" : (r.stdout || r.stderr).split("\n")[0].trim(); };
	return { iec2c: v("iec2c", ["-v"]), cc: v("cc", ["--version"]) };
}
function recordGate(dir: string, gate: string, ok: boolean, detail: string) {
	const { hash } = hashVerify(dir);
	stampAppend(dir, { event: "gate", hash, gate, ok, detail: detail.slice(0, 2000) });
}

// ---- Gate S: static checks (3.5). Stricter than the spec on purpose: exactly one assignment site per output. ----
const stripComments = (s: string) => s.replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/\/\/.*$/gm, " ");
export function gateS(src: string): string[] {
	const bad: string[] = [];
	if (/[^\x00-\x7f]/.test(src)) bad.push("non-ASCII source (matiec reads ASCII only)");
	const s = stripComments(src);
	if (/\b(WHILE|REPEAT)\b/i.test(s)) bad.push("WHILE or REPEAT loop");
	const num = /^[-+]?\d+$/;
	for (const m of s.matchAll(/\bFOR\b\s+[A-Za-z_]\w*\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO\b/gis))
		if (![m[1], m[2], m[3] ?? "1"].every((x) => num.test(x.trim()))) bad.push(`FOR loop with non-constant bounds: ${m[0].replace(/\s+/g, " ").slice(0, 60)}`);
	for (const m of s.matchAll(/\b(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_]\w*)([\s\S]*?)\bEND_\1\b/gi))
		if (new RegExp(`\\b${m[2]}\\s*\\(`, "i").test(m[3])) bad.push(`recursion in ${m[2]}`);
	const outs = new Set<string>();
	for (const m of s.matchAll(/([A-Za-z_]\w*)\s+AT\s+%Q/gi)) outs.add(m[1]);
	for (const b of s.matchAll(/VAR_OUTPUT[\s\S]*?END_VAR/gi))
		for (const d of b[0].split(";")) { const names = d.replace(/VAR_OUTPUT|END_VAR/gi, "").split(":")[0]; if (d.includes(":")) names.split(",").forEach((n) => n.trim() && outs.add(n.trim())); }
	for (const o of outs) {
		const sites = [...s.matchAll(new RegExp(`\\b${o}\\s*:=`, "gi"))].length;
		if (sites > 1) bad.push(`output ${o} has ${sites} assignment sites (needs exactly one)`);
	}
	return bad;
}

// ---- runner: every gate process runs with network denied, asserted by a loopback probe (3.1) ----
export function denyWrap(cmd: string, args: string[]): [string, string[]] {
	if (process.platform === "linux") return ["unshare", ["-rn", "--", cmd, ...args]];
	if (process.platform === "darwin") return ["/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", cmd, ...args]];
	throw new Error(`no network-deny wrapper for ${process.platform}: refusing`);
}
export function runDenied(cmd: string, args: string[], input?: string, cwd?: string) {
	const [c, a] = denyWrap(cmd, args);
	const r = spawnSync(c, a, { input, cwd, encoding: "utf8", timeout: 60_000 });
	return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
/** Fail closed: the parent listens on loopback, the denied child tries to connect, nothing may arrive. */
export async function assertNetworkDenied(bin: string) {
	let hits = 0;
	const srv = net.createServer((s) => { hits++; s.destroy(); });
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as net.AddressInfo).port;
	const p = runDenied(bin, ["--probe", String(port)]);
	await new Promise((r) => setTimeout(r, 150));
	srv.close();
	if (p.code !== 0 || hits > 0) throw new Error(`network not denied (probe exit ${p.code}, ${hits} connections, ${p.err.trim().slice(0, 120)}): refusing to run gates`);
}

// ---- tests as data ----
type Cycle = { in?: Record<string, number>; out?: Record<string, number> };
export interface Tests {
	defaults: Record<string, number>;
	heartbeat?: string;
	cases: { name: string; cycles: Cycle[] }[];
	safety: { estop: string; asserted: number; faults: { input: string; value: number }[]; safe: Record<string, number>; watchdogScans?: number; maxRunScans?: number; runCase?: string };
}
class Seq {
	state: Record<string, number>; hb = 0; lines: string[] = [];
	constructor(private t: Tests, prefix: Cycle[] = []) { this.state = { ...t.defaults }; prefix.forEach((c) => this.push(c.in)); }
	push(mod: Record<string, number> = {}, freezeHb = false) {
		Object.assign(this.state, mod);
		if (this.t.heartbeat && !freezeHb) { this.hb = this.hb ? 0 : 1; this.state[this.t.heartbeat] = this.hb; }
		this.lines.push(Object.entries(this.state).map(([k, v]) => `${k}=${v}`).join(" "));
		return this.lines.length - 1;
	}
}
const parseOut = (s: string) => s.split("\n").filter(Boolean).map((l) => Object.fromEntries(l.split(" ").map((t) => t.split("=")).map(([k, v]) => [k, Number(v)])));
export type Runner = (cmd: string, args: string[], input?: string) => { code: number; out: string; err: string };
function scan(bin: string, seq: Seq, run: Runner = runDenied) {
	const r = run(bin, [], seq.lines.join("\n") + "\n");
	const o = parseOut(r.out);
	if (r.code !== 0 || o.length !== seq.lines.length) throw new Error(`harness failed (exit ${r.code}, ${o.length}/${seq.lines.length} scans): ${r.err.slice(0, 200)}`);
	return o;
}
const miss = (got: Record<string, number>, want: Record<string, number>) => Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}=${got[k]} want ${v}`);

export function gateB(bin: string, t: Tests, run: Runner = runDenied): string[] {
	const bad: string[] = [];
	for (const c of t.cases) {
		const seq = new Seq(t, c.cycles);
		const o = scan(bin, seq, run);
		c.cycles.forEach((cy, i) => { const m = miss(o[i], cy.out ?? {}); if (m.length) bad.push(`${c.name} scan ${i + 1}: ${m.join(", ")}`); });
	}
	return bad;
}
/** Gate C: from every prefix of every case, assert e-stop, each input fault and a frozen heartbeat; all must reach the safe state in the same scan. */
export function gateC(bin: string, t: Tests, run: Runner = runDenied): string[] {
	const bad: string[] = [], sf = t.safety;
	const expectSafe = (label: string, seq: Seq, from: number, o: Record<string, number>[]) => {
		for (let i = from; i < o.length; i++) { const m = miss(o[i], sf.safe); if (m.length) { bad.push(`${label} scan +${i - from}: ${m.join(", ")}`); return; } }
	};
	for (const c of t.cases) {
		const n = c.cycles.length;
		const ks = [...new Set([...Array(n + 1).keys()].filter((k) => k <= 8 || k % 10 === 0).concat(n))];
		for (const k of ks) {
			const tag = `${c.name}@${k}`;
			let s = new Seq(t, c.cycles.slice(0, k)); let at = s.push({ [sf.estop]: sf.asserted }); s.push(); s.push();
			expectSafe(`estop ${tag}`, s, at, scan(bin, s, run).slice(0));
			at = s.push({ [sf.estop]: 1 - sf.asserted }); s.push(); s.push();
			expectSafe(`estop release ${tag}`, s, at, scan(bin, s, run));
			for (const f of sf.faults) {
				s = new Seq(t, c.cycles.slice(0, k)); at = s.push({ [f.input]: f.value }); s.push(); s.push();
				expectSafe(`fault ${f.input} ${tag}`, s, at, scan(bin, s, run));
			}
			if (sf.watchdogScans && t.heartbeat) {
				s = new Seq(t, c.cycles.slice(0, k)); const L = sf.watchdogScans;
				for (let i = 0; i < L + 2; i++) s.push({}, true);
				expectSafe(`watchdog ${tag}`, s, k + L, scan(bin, s, run));
			}
		}
	}
	if (sf.maxRunScans && sf.runCase) {
		const c = t.cases.find((x) => x.name === sf.runCase);
		if (!c) bad.push(`runCase ${sf.runCase} not found`);
		else { const s = new Seq(t, c.cycles); for (let i = 0; i < sf.maxRunScans + 1; i++) s.push(); const o = scan(bin, s, run); expectSafe("run timeout", s, s.lines.length - 1, o); }
	}
	return bad;
}

/** ptrs.h for harness.c, from matiec's LOCATED_VARIABLES.h. BOOL located variables only in slice 1. */
export function ptrsHeader(loc: string): string | { error: string } {
	const vars = [...loc.matchAll(/__LOCATED_VAR\(\s*(\w+)\s*,\s*(__[IQM][XBWDL]\d+(?:_\d+)*)/g)];
	if (!vars.length) return { error: "no located variables found" };
	if (vars.some((v) => v[1] !== "BOOL")) return { error: "slice 1 supports BOOL located variables only" };
	return vars.map((v) => `extern unsigned char *${v[2]};`).join("\n") +
		`\nstatic struct { const char *n; unsigned char *p; } PTR[] = {${vars.map((v) => `{"${v[2].slice(2).replace(/_/g, ".")}", NULL}`).join(",")}};\n` +
		`static const int NPTR = ${vars.length};\n#define PTR_INIT() do { ${vars.map((v, i) => `PTR[${i}].p = ${v[2]};`).join(" ")} } while (0)\n`;
}

// ---- Gates A to C end to end ----
export interface GateResult { gate: string; ok: boolean; detail: string }
export async function runLane(cfg: LaneConfig, dir: string): Promise<{ ok: boolean; skipped?: string; results: GateResult[] }> {
	if (!inside(cfg.quarantineDir, dir)) throw new Error("program is not in quarantine");
	const results: GateResult[] = [];
	const done = (gate: string, bad: string[]) => { const ok = !bad.length; results.push({ gate, ok, detail: bad.join("; ") }); recordGate(dir, gate, ok, bad.join("; ")); return ok; };
	hashVerify(dir);
	const src = fs.readFileSync(path.join(dir, "program.st"), "utf8");
	if (!done("S", gateS(src))) return { ok: false, results };
	const which = spawnSync("sh", ["-c", "command -v iec2c"], { encoding: "utf8" }).stdout.trim();
	if (!which) return { ok: false, results, skipped: "iec2c (matiec) not found; Gates A, B, C not run. Install is a separate, human-approved step on 8gi-ci-1." };
	const lib = process.env.MATIEC_LIB ?? path.join(path.dirname(fs.realpathSync(which)), "lib");
	const build = path.join(dir, "build");
	fs.rmSync(build, { recursive: true, force: true }); fs.mkdirSync(build, { recursive: true });
	hashVerify(dir);
	const a = runDenied("iec2c", ["-I", lib, "-T", build, path.join(dir, "program.st")]);
	if (!done("A", a.code === 0 ? [] : [`iec2c exit ${a.code}: ${(a.err || a.out).slice(0, 300)}`])) return { ok: false, results };
	const ptrs = ptrsHeader(fs.readFileSync(path.join(build, "LOCATED_VARIABLES.h"), "utf8"));
	if (typeof ptrs !== "string") return { ok: done("B", [ptrs.error]), results };
	qwrite(cfg, path.join(build, "ptrs.h"), ptrs);
	qwrite(cfg, path.join(build, "harness.c"), fs.readFileSync(path.join(HERE, "harness.c")));
	const bin = path.join(build, "harness");
	const cc = spawnSync("cc", ["-w", "-I", build, "-I", path.join(lib, "C"), "-I", lib, "-o", bin, path.join(build, "harness.c"), ...fs.readdirSync(build).filter((f) => f.endsWith(".c") && f !== "harness.c").map((f) => path.join(build, f))], { encoding: "utf8" });
	if (cc.status !== 0) return { ok: done("B", [`harness compile failed: ${cc.stderr.slice(0, 300)}`]), results };
	await assertNetworkDenied(bin);
	const tests = JSON.parse(fs.readFileSync(path.join(dir, "tests.json"), "utf8")) as Tests;
	hashVerify(dir);
	if (!done("B", gateB(bin, tests))) return { ok: false, results };
	hashVerify(dir);
	return { ok: done("C", gateC(bin, tests)), results };
}

if (import.meta.main) {
	const [cmd, a, b, c] = process.argv.slice(2);
	const cfg = loadConfig();
	try {
		if (cmd === "stage") console.log(stage(cfg, a, fs.readFileSync(b, "utf8"), fs.readFileSync(c, "utf8"), process.argv[6] ?? ""));
		else if (cmd === "hash-verify") console.log(hashVerify(path.resolve(a)).hash, "ok");
		else if (cmd === "run") { const r = await runLane(cfg, path.resolve(a)); console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : r.skipped ? 3 : 1); }
		else { console.error("usage: lane.ts stage <name> <program.st> <tests.json> <author> | hash-verify <dir> | run <dir>"); process.exit(2); }
	} catch (e) { console.error(String((e as Error).message)); process.exit(1); }
}
