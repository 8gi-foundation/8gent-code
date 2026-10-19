import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { RUN_BATCH_MAX_ITEMS, runBatch, runBatchOn } from "./run-batch";
import { ToolExecutor } from "./tools";

const names = (ex: ToolExecutor) =>
	(ex.getToolDefinitions() as { function: { name: string } }[]).map((d) => d.function.name);

afterEach(() => {
	delete process.env.EIGHT_RUN_BATCH;
});

describe("run_batch flag", () => {
	test("off by default, on only with exactly 1", () => {
		expect(runBatchOn()).toBe(false);
		process.env.EIGHT_RUN_BATCH = "true";
		expect(runBatchOn()).toBe(false);
		process.env.EIGHT_RUN_BATCH = "1";
		expect(runBatchOn()).toBe(true);
	});
	test("advertised only when on; description opens with the input shape", () => {
		const ex = new ToolExecutor(os.tmpdir());
		expect(names(ex)).not.toContain("run_batch");
		process.env.EIGHT_RUN_BATCH = "1";
		const def = (
			ex.getToolDefinitions() as { function: { name: string; description: string } }[]
		).find((d) => d.function.name === "run_batch");
		expect(def?.function.description.split(".")[0]).toContain("{tool, args}");
	});
	test("executor refuses run_batch when off", async () => {
		const r = await new ToolExecutor(os.tmpdir()).execute("run_batch", { items: [] });
		expect(r).toContain("not enabled");
	});
});

describe("runBatch", () => {
	test("read-only items overlap, results stay in order", async () => {
		let live = 0;
		let peak = 0;
		const exec = async (t: string) => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 20));
			live--;
			return `body-${t}`;
		};
		const out = await runBatch(
			[{ tool: "read_file" }, { tool: "list_files" }, { tool: "locate" }],
			exec,
		);
		expect(peak).toBe(3);
		expect(out.indexOf("1. read_file ok")).toBeLessThan(out.indexOf("2. list_files ok"));
		expect(out).toContain("body-locate");
	});
	test("write items run strictly in order", async () => {
		const log: string[] = [];
		const exec = async (t: string) => {
			log.push(`start ${t}`);
			await new Promise((r) => setTimeout(r, 10));
			log.push(`end ${t}`);
			return "done";
		};
		await runBatch([{ tool: "edit_file" }, { tool: "run_command" }], exec);
		expect(log).toEqual([
			"start edit_file",
			"end edit_file",
			"start run_command",
			"end run_command",
		]);
	});
	test("a failed write cancels later writes but not later reads", async () => {
		const ran: string[] = [];
		const exec = async (t: string) => {
			ran.push(t);
			return t === "edit_file" ? "Error: no match" : "fine";
		};
		const out = await runBatch(
			[
				{ tool: "edit_file" },
				{ tool: "run_command" },
				{ tool: "read_file" },
				{ tool: "write_file" },
			],
			exec,
		);
		expect(ran).toEqual(["edit_file", "read_file"]);
		expect(out).toContain("1. edit_file FAILED");
		expect(out).toContain("2. run_command cancelled");
		expect(out).toContain("3. read_file ok");
		expect(out).toContain("4. write_file cancelled");
	});
	test("a thrown error and a [BLOCKED] result both count as failure", async () => {
		const out = await runBatch([{ tool: "read_file" }, { tool: "edit_file" }], async (t) => {
			if (t === "read_file") throw new Error("boom");
			return "[BLOCKED] nope";
		});
		expect(out).toContain("1. read_file FAILED\nError: boom");
		expect(out).toContain("2. edit_file cancelled");
	});
	test("bad input runs nothing", async () => {
		const exec = async () => {
			throw new Error("must not run");
		};
		expect(await runBatch([], exec)).toContain("Nothing was run");
		expect(await runBatch([{ tool: "run_batch" }], exec)).toContain("cannot contain run_batch");
		expect(await runBatch([{ args: {} }], exec)).toContain("no tool name");
		expect(
			await runBatch(new Array(RUN_BATCH_MAX_ITEMS + 1).fill({ tool: "read_file" }), exec),
		).toContain("at most");
	});
	test("long item output is cut with a pointer to the single call", async () => {
		const out = await runBatch([{ tool: "read_file" }], async () => "x".repeat(5000));
		expect(out).toContain("call read_file alone");
		expect(out.length).toBeLessThan(2000);
	});
});

describe("executor path", () => {
	test("items go back through execute, so real tools run", async () => {
		process.env.EIGHT_RUN_BATCH = "1";
		const ex = new ToolExecutor(process.cwd());
		const out = await ex.execute("run_batch", {
			items: [
				{ tool: "read_file", args: { path: "package.json" } },
				{ tool: "read_file", args: { path: "../../etc/passwd" } },
			],
		});
		expect(out).toContain("1. read_file ok");
		expect(out).toContain("2. read_file FAILED");
	});
});
