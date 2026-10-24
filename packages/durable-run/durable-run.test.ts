/**
 * Kill test for durable runs (#4883): kill the process at every tick of a scripted run (search,
 * write a file, send through a stubbed Telegram send), resume from a DIFFERENT client process, and
 * require the file written once and the message sent once. Real store, real CLI process, real
 * permission gate; only the model (Pi's scripted provider) and the Telegram receiver are stubs.
 *
 * Runs under Bun always, and under the Node build when dist/node/cli.js and Node 22 exist
 * (bun --config=bin/bunfig.empty.toml scripts/build-node.ts first).
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { EffectLedger } from "./ledger.js";
import { type DurableDeps, durableTool } from "./tools.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const NODE_CLI = path.join(ROOT, "dist/node/cli.js");
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const fresh = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "durable-run-"));
	roots.push(d);
	return d;
};

type Runtime = { name: string; cmd: string[] };
const RUNTIMES: Runtime[] = [{ name: "bun", cmd: ["bun", path.join(ROOT, "bin/8gent.ts")] }];
if (fs.existsSync(NODE22) && fs.existsSync(NODE_CLI)) {
	RUNTIMES.push({ name: "node22", cmd: [NODE22, NODE_CLI] });
}

async function client(rt: Runtime, dir: string, args: string[]) {
	const proc = Bun.spawn([...rt.cmd, "durable-run", dir, ...args], {
		cwd: ROOT,
		env: {
			...process.env,
			EIGHT_DURABLE_RUN: "1",
			EIGHT_DATA_DIR: path.join(dir, "data"),
			NODE_NO_WARNINGS: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, signal: proc.signalCode, out: out.trim(), err };
}

const rows = (file: string): Record<string, string>[] =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

/** One kill position: first client dies at tick n, a second client resumes. */
async function killAndResume(rt: Runtime, variant: string, n: number) {
	const dir = fresh();
	const first = await client(rt, dir, [`--variant=${variant}`, `--kill-at=${n}`, "--client=tui"]);
	const killed = first.signal === "SIGKILL";
	const second = await client(rt, dir, [`--variant=${variant}`, "--client=phone"]);
	return { dir, killed, first, second };
}

function counts(dir: string) {
	const e = rows(path.join(dir, "effects.log"));
	return {
		writes: e.filter((r) => r.ev === "write").length,
		sends: e.filter((r) => r.ev === "send").length,
		file: fs.existsSync(path.join(dir, "out/notes.txt"))
			? fs.readFileSync(path.join(dir, "out/notes.txt"), "utf8")
			: null,
	};
}

async function totalTicks(rt: Runtime): Promise<number> {
	const dir = fresh();
	const r = await client(rt, dir, []);
	expect(r.code).toBe(0);
	return JSON.parse(r.out).ticks as number;
}

for (const rt of RUNTIMES) {
	describe(`kill at every tick, resume from another client (${rt.name})`, () => {
		test("variant key: file written once, message sent once, at every position", async () => {
			const N = await totalTicks(rt);
			expect(N).toBeGreaterThan(100);
			let killedAt = 0;
			for (let n = 1; n <= N; n++) {
				const r = await killAndResume(rt, "key", n);
				if (r.killed) killedAt++;
				expect(r.second.code, `n=${n} resume: ${r.second.err}`).toBe(0);
				const c = counts(r.dir);
				expect(c, `n=${n}`).toEqual({ writes: 1, sends: 1, file: "release notes: durable runs\n" });
			}
			expect(killedAt).toBeGreaterThan(N - 3); // nearly every position really was a kill
		}, 600_000);

		for (const variant of ["nokey", "undeclared"]) {
			test(`variant ${variant}: never sent twice; a cut-off send is shown, not repeated`, async () => {
				const N = await totalTicks(rt);
				let unresolvedSeen = 0;
				for (let n = 1; n <= N; n += 3) {
					const r = await killAndResume(rt, variant, n);
					expect(r.second.code, `n=${n}: ${r.second.err}`).toBe(0);
					const c = counts(r.dir);
					expect(c.writes, `n=${n}`).toBe(1);
					expect(c.sends, `n=${n}`).toBeLessThanOrEqual(1);
					if (c.sends === 0) {
						// The send did not happen or its outcome is unknown: it must be listed for a person.
						const ledger = new EffectLedger(path.join(r.dir, "run.sqlite"));
						expect(
							ledger.unresolved().map((u) => u.tool),
							`n=${n}`,
						).toContain("telegram_send");
						ledger.close();
						unresolvedSeen++;
					}
				}
				expect(unresolvedSeen).toBeGreaterThan(0);
			}, 600_000);
		}

		test("the gate stands in front of a replay: the resuming client is gated again", async () => {
			const dir = fresh();
			const log = path.join(dir, "ticks.log");
			const probe = await client(rt, dir, [`--tick-log=${log}`]);
			expect(probe.code).toBe(0);
			const afterEffect = fs
				.readFileSync(log, "utf8")
				.split("\n")
				.find((l) => l.endsWith("write_file:after-effect"));
			const n = Number(afterEffect?.split(" ")[0]);
			expect(n).toBeGreaterThan(0);
			const r = await killAndResume(rt, "key", n);
			expect(r.killed).toBe(true);
			const gates = rows(path.join(r.dir, "gate.log")).filter((g) => g.tool === "write_file");
			expect(gates.map((g) => g.client)).toEqual(["tui", "phone"]); // killed after the effect, rerun and gated again
			expect(counts(r.dir).writes).toBe(1);
		}, 120_000);

		test("the run file is private", async () => {
			const dir = fresh();
			expect((await client(rt, dir, [])).code).toBe(0);
			for (const f of ["run.sqlite", "run.sqlite-wal", "run.sqlite-shm"]) {
				const p = path.join(dir, f);
				if (fs.existsSync(p)) expect((fs.statSync(p).mode & 0o777).toString(8), f).toBe("600");
			}
		}, 60_000);
	});
}

describe("the replay rule, one tool at a time", () => {
	const api = { conversationId: 1, callId: "c1" } as never;
	const ctx = {} as never;
	function setup(
		spec: Partial<Parameters<typeof durableTool>[0]> & { runs: { n: number } },
		allow = true,
	) {
		const ledger = new EffectLedger(path.join(fresh(), "l.sqlite"));
		const deps: DurableDeps = {
			ledger,
			gate: async () => (allow ? { run: true } : { run: false, reason: "denied" }),
		};
		const tool = durableTool(
			{
				name: "t",
				description: "t",
				parameters: Type.Object({}),
				...spec,
				run: async () => {
					spec.runs.n++;
					return "ran";
				},
			} as never,
			deps,
		);
		return { tool, ledger };
	}
	const text = (r: { output?: { text: string }[] }) => r.output?.[0]?.text;

	test("an undeclared tool counts as ask: unsafe to Pi, never rerun after a cut", async () => {
		const runs = { n: 0 };
		const { tool, ledger } = setup({ runs });
		expect(tool.replay).toBe("unsafe");
		ledger.start("1:c1", "t"); // a cut-off earlier attempt
		const r = (await tool.execute({}, api, ctx)) as {
			isError?: boolean;
			output?: { text: string }[];
		};
		expect(r.isError).toBe(true);
		expect(runs.n).toBe(0);
		expect(ledger.unresolved().length).toBe(1);
	});

	test("once without a key honoured by the target: a cut-off call is not rerun", async () => {
		const runs = { n: 0 };
		const { tool, ledger } = setup({ runs, replay: "once" });
		ledger.start("1:c1", "t");
		const r = (await tool.execute({}, api, ctx)) as { isError?: boolean };
		expect(r.isError).toBe(true);
		expect(runs.n).toBe(0);
	});

	test("once with idempotentByKey reruns a cut-off call, then never again", async () => {
		const runs = { n: 0 };
		const { tool, ledger } = setup({ runs, replay: "once", idempotentByKey: true });
		ledger.start("1:c1", "t");
		expect(text((await tool.execute({}, api, ctx)) as never)).toBe("ran");
		expect(text((await tool.execute({}, api, ctx)) as never)).toBe("ran");
		expect(runs.n).toBe(1); // the second call came from the ledger
		expect(ledger.unresolved().length).toBe(0);
	});

	test("a denied call runs nothing and records nothing", async () => {
		const runs = { n: 0 };
		const { tool, ledger } = setup({ runs, replay: "once" }, false);
		const r = (await tool.execute({}, api, ctx)) as {
			isError?: boolean;
			output?: { text: string }[];
		};
		expect(r.isError).toBe(true);
		expect(text(r as never)).toContain("denied");
		expect(runs.n).toBe(0);
		expect(ledger.get("1:c1")).toBeUndefined();
	});
});
