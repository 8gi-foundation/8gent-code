/**
 * Startup timing for 8gent (Pi parity row C3, umbrella #3918).
 *
 *   bun scripts/perf/startup.ts [--runs 5] [--out file.json] [--check]
 *
 * Measures, each run in a fresh process, N runs, median and p90:
 *  1. version_ms        `bun bin/8gent.ts --version`, spawn to exit.
 *  2. headless_run      `bun bin/8gent.ts run --output-format stream-json` against
 *                       scripts/ci/stub-model-server.ts (no model, no network):
 *                       first_byte_ms   spawn to first stdout byte (session_start event)
 *                       first_model_ms  spawn to first event produced from the model's
 *                                       reply (assistant text or tool_use; the stub's
 *                                       first reply is a tool call)
 *                       exit_ms         spawn to exit
 *                       `-p` is measured too when bin/8gent.ts supports it.
 *  3. tui_fake_tty      FAKE-TTY, IN-PROCESS. The real App on the fake TTY
 *                       (apps/tui/src/__tests__/app-driver.tsx), process start to the
 *                       normal input prompt, minus the driver's scripted waits. Not
 *                       terminal startup: the sandbox and CI have no pty.
 *
 * Writes JSON to --out (default $TMPDIR/8gent-perf-<date>-<sha>.json) and prints
 * the JSON plus a table. With --check, compares medians to scripts/perf/budget.json
 * for this platform and exits 1 only when one exceeds its budget by more than 25%.
 * A null or missing budget means report-only.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harnessEnv } from "../../apps/tui/src/__tests__/app-driver.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const ENTRY = path.join(ROOT, "bin/8gent.ts");
const STUB = path.join(ROOT, "scripts/ci/stub-model-server.ts");
const HARNESS = path.join(import.meta.dir, "tui-ready.harness.tsx");
const PRELOAD = path.join(ROOT, "tests/preload-ink-interactive.ts");
const BUDGET_TOLERANCE = 1.25;

function arg(name: string, dflt?: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : dflt;
}
const RUNS = Number(arg("--runs", "5"));

export interface Stat {
	n: number;
	median: number;
	p90: number;
	min: number;
	max: number;
	samples: number[];
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Median and nearest-rank p90. */
export function stat(samples: number[]): Stat {
	const s = [...samples].sort((a, b) => a - b);
	const p90 = s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.9 * s.length) - 1))];
	const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	return {
		n: s.length,
		median: round(mid),
		p90: round(p90),
		min: round(s[0]),
		max: round(s[s.length - 1]),
		samples: samples.map(round),
	};
}

async function runTimed(
	cmd: string[],
	env: Record<string, string>,
	cwd: string,
	onLine?: (line: string, at: number) => void,
): Promise<{ firstByte: number; exit: number; code: number; stdout: string }> {
	const t0 = performance.now();
	const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
	let firstByte = Number.NaN;
	let buf = "";
	let all = "";
	const dec = new TextDecoder();
	const reading = (async () => {
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			const at = performance.now() - t0;
			if (Number.isNaN(firstByte)) firstByte = at;
			const text = dec.decode(chunk, { stream: true });
			all += text;
			buf += text;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				onLine?.(buf.slice(0, nl), at);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
			}
		}
	})();
	const errDrain = new Response(proc.stderr).text();
	const code = await proc.exited;
	const exit = performance.now() - t0;
	await reading;
	await errDrain;
	return { firstByte, exit, code, stdout: all };
}

/** Best-effort temp removal: Windows can hold a just-exited child's directory briefly. */
function cleanup(dir: string) {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {}
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.endsWith("_API_KEY")) env[k] = v;
	}
	return Object.assign(env, extra);
}

async function startStub(): Promise<{ port: number; stop: () => void }> {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proc = Bun.spawn([process.execPath, STUB, String(port)], { stdout: "ignore", stderr: "ignore" });
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
			if (r.ok) return { port, stop: () => proc.kill() };
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	proc.kill();
	throw new Error("stub model server did not come up");
}

function gitSha(): string {
	const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : "nogit";
}

function machine() {
	const cpus = os.cpus();
	return {
		platform: process.platform,
		arch: process.arch,
		cpu: cpus[0]?.model ?? "unknown",
		cores: cpus.length,
		mem_gb: Math.round(os.totalmem() / 2 ** 30),
		bun: Bun.version,
		ci: !!process.env.CI,
	};
}

async function measureVersion() {
	const ms: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-perf-"));
		const r = await runTimed([process.execPath, ENTRY, "--version"], cleanEnv({ HOME: home, USERPROFILE: home }), ROOT);
		cleanup(home);
		if (r.code !== 0) throw new Error(`--version exited ${r.code}`);
		ms.push(r.exit);
	}
	return stat(ms);
}

function supportsDashP(): boolean {
	return /(^|\n)\s*case\s+"-p"/.test(fs.readFileSync(ENTRY, "utf8"));
}

async function measureHeadless(port: number, form: "run" | "-p") {
	const firstByte: number[] = [];
	const firstModel: number[] = [];
	const exit: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-perf-"));
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-perf-work-"));
		const env = cleanEnv({
			HOME: home,
			USERPROFILE: home,
			OLLAMA_HOST: `http://127.0.0.1:${port}`,
			EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
			CI: "true",
		});
		const common = ["--yes", "--provider", "ollama", "--model", "stub", "--cwd", work, "--output-format", "stream-json"];
		const cmd =
			form === "run"
				? [process.execPath, ENTRY, "run", ...common, "Create hello.txt"]
				: [process.execPath, ENTRY, "-p", "Create hello.txt", ...common];
		let modelAt = Number.NaN;
		const r = await runTimed(cmd, env, ROOT, (line, at) => {
			if (!Number.isNaN(modelAt) || !line.startsWith("{")) return;
			try {
				const t = JSON.parse(line).type;
				if (t === "assistant" || t === "tool_use") modelAt = at;
			} catch {}
		});
		cleanup(home);
		cleanup(work);
		if (r.code !== 0) throw new Error(`headless ${form} exited ${r.code}: ${r.stdout.slice(-400)}`);
		if (Number.isNaN(modelAt)) throw new Error(`headless ${form}: no assistant/tool_use event seen`);
		firstByte.push(r.firstByte);
		firstModel.push(modelAt);
		exit.push(r.exit);
	}
	return { first_byte_ms: stat(firstByte), first_model_ms: stat(firstModel), exit_ms: stat(exit) };
}

async function measureTui() {
	const ready: number[] = [];
	const imp: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-perf-"));
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const p = new URL(req.url).pathname;
				if (p === "/api/tags") return Response.json({ models: [{ name: "perf:1b", model: "perf:1b", size: 1 }] });
				if (p === "/api/version") return Response.json({ version: "0.0.0" });
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const r = await runTimed([process.execPath, "--preload", PRELOAD, HARNESS], harnessEnv(base, home, {}), ROOT);
			const line = r.stdout
				.split("\n")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping BEL
				.map((l) => l.replace(/^[\x00-\x1f]+/, ""))
				.find((l) => l.startsWith("{"));
			const ev = line ? JSON.parse(line) : null;
			if (!ev || ev.phase !== "ready") throw new Error(`tui harness failed: ${line ?? r.stdout.slice(-400)}`);
			ready.push(ev.ready_ms);
			imp.push(ev.import_ms);
		} finally {
			server.stop(true);
			cleanup(home);
		}
	}
	return {
		label: "fake-TTY, in-process (not terminal startup)",
		ready_ms: stat(ready),
		import_ms: stat(imp),
	};
}

type Flat = Record<string, number>;
// biome-ignore lint/suspicious/noExplicitAny: report object assembled in main
function flatten(res: any): Flat {
	return {
		version_ms: res.version_ms.median,
		"headless_run.first_byte_ms": res.headless_run.first_byte_ms.median,
		"headless_run.first_model_ms": res.headless_run.first_model_ms.median,
		"headless_run.exit_ms": res.headless_run.exit_ms.median,
		"tui_fake_tty.ready_ms": res.tui_fake_tty.ready_ms.median,
	};
}

export function checkBudget(flat: Flat, budget: Record<string, Record<string, number | null>>, platform: string): string[] {
	const mine = budget[platform] ?? {};
	const fails: string[] = [];
	for (const [k, v] of Object.entries(flat)) {
		const b = mine[k];
		if (typeof b === "number" && v > b * BUDGET_TOLERANCE) {
			fails.push(`${k}: median ${v} ms > budget ${b} ms x ${BUDGET_TOLERANCE}`);
		}
	}
	return fails;
}

// biome-ignore lint/suspicious/noExplicitAny: report object assembled in main
function table(res: any): string {
	const rows: [string, Stat][] = [
		["--version", res.version_ms],
		["run: first stdout byte", res.headless_run.first_byte_ms],
		["run: first model event", res.headless_run.first_model_ms],
		["run: exit", res.headless_run.exit_ms],
		["TUI ready (fake-TTY, in-process)", res.tui_fake_tty.ready_ms],
		["  of which import ink+App", res.tui_fake_tty.import_ms],
	];
	if (res.headless_p) {
		rows.push(["-p: first stdout byte", res.headless_p.first_byte_ms]);
		rows.push(["-p: first model event", res.headless_p.first_model_ms]);
		rows.push(["-p: exit", res.headless_p.exit_ms]);
	}
	const w = Math.max(...rows.map((r) => r[0].length));
	const lines = [`${"metric".padEnd(w)}  median_ms  p90_ms    min    max   (n=${RUNS})`];
	for (const [name, s] of rows) {
		lines.push(
			`${name.padEnd(w)}  ${String(s.median).padStart(9)}  ${String(s.p90).padStart(6)}  ${String(s.min).padStart(5)}  ${String(s.max).padStart(5)}`,
		);
	}
	return lines.join("\n");
}

async function main() {
	const sha = gitSha();
	const date = new Date().toISOString().slice(0, 10);
	const out = arg("--out") ?? path.join(process.env.TMPDIR ?? os.tmpdir(), `8gent-perf-${date}-${sha}.json`);
	// biome-ignore lint/suspicious/noExplicitAny: report object assembled in main
	const res: any = { date, sha, runs: RUNS, machine: machine() };
	res.version_ms = await measureVersion();
	const stub = await startStub();
	try {
		res.headless_run = await measureHeadless(stub.port, "run");
		if (supportsDashP()) res.headless_p = await measureHeadless(stub.port, "-p");
	} finally {
		stub.stop();
	}
	res.tui_fake_tty = await measureTui();
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, `${JSON.stringify(res, null, 2)}\n`);
	console.log(JSON.stringify(res));
	const m = res.machine;
	console.log(`\n${table(res)}\n\nmachine: ${m.platform}/${m.arch} ${m.cpu} x${m.cores}, ${m.mem_gb} GB, bun ${m.bun}\nwrote ${out}`);
	if (process.argv.includes("--check")) {
		const budget = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "budget.json"), "utf8"));
		const fails = checkBudget(flatten(res), budget, process.platform);
		if (fails.length) {
			console.error(`BUDGET EXCEEDED:\n${fails.join("\n")}`);
			process.exit(1);
		}
		console.log("budget: ok (null entries are report-only)");
	}
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
