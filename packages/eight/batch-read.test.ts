import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BATCH_MAX_CALLS } from "./batch-read";
import { ToolExecutor } from "./tools";

const made: string[] = [];
afterAll(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-read-"));
	made.push(root);
	fs.writeFileSync(path.join(root, "a.txt"), "alpha line\n");
	fs.writeFileSync(path.join(root, "b.txt"), "beta line\n");
	return root;
}

describe("batch", () => {
	test("is offered to the model with its limit in the description", () => {
		const defs = new ToolExecutor(project()).getToolDefinitions() as {
			function: { name: string; description: string };
		}[];
		const def = defs.find((d) => d.function.name === "batch");
		expect(def).toBeDefined();
		expect(def?.function.description).toContain(String(BATCH_MAX_CALLS));
	});

	test("runs read calls and labels one section per call, in order", async () => {
		const ex = new ToolExecutor(project());
		const out = await ex.execute("batch", {
			calls: [
				{ tool: "read_file", args: { path: "a.txt" } },
				{ tool: "search_files", args: { pattern: "beta" } },
				{ tool: "list_files", args: {} },
			],
		});
		expect(out).toContain("[1/3 read_file]");
		expect(out).toContain("alpha line");
		expect(out).toContain("[2/3 search_files]");
		expect(out).toContain("b.txt:1");
		expect(out).toContain("[3/3 list_files]");
		expect(out.indexOf("[1/3")).toBeLessThan(out.indexOf("[2/3"));
	});

	test("refuses a write, a shell, a network call or a nested batch and runs nothing", async () => {
		const root = project();
		const ex = new ToolExecutor(root);
		for (const tool of ["write_file", "edit_file", "run_command", "web_fetch", "batch"]) {
			const out = await ex.execute("batch", {
				calls: [
					{ tool: "read_file", args: { path: "a.txt" } },
					{ tool, args: { path: "z.txt", content: "x", command: "touch z.txt", url: "https://x.test" } },
				],
			});
			expect(out).toContain(`batch only runs read-only tools, and ${tool} is not one`);
			expect(out).toContain("Nothing was run");
			expect(out).not.toContain("alpha line");
		}
		expect(fs.existsSync(path.join(root, "z.txt"))).toBe(false);
	});

	test("refuses more than the limit and an empty list", async () => {
		const ex = new ToolExecutor(project());
		const many = Array.from({ length: BATCH_MAX_CALLS + 1 }, () => ({
			tool: "read_file",
			args: { path: "a.txt" },
		}));
		expect(await ex.execute("batch", { calls: many })).toContain(`at most ${BATCH_MAX_CALLS}`);
		expect(await ex.execute("batch", { calls: [] })).toContain("needs calls");
	});

	test("a path outside the workspace is refused as on its own; sibling calls still run", async () => {
		const ex = new ToolExecutor(project());
		const solo = await ex.execute("read_file", { path: "../../../../etc/hosts" });
		const out = await ex.execute("batch", {
			calls: [
				{ tool: "read_file", args: { path: "a.txt" } },
				{ tool: "read_file", args: { path: "../../../../etc/hosts" } },
			],
		});
		expect(out).toContain("alpha line");
		expect(out).toContain(solo.split("\n")[0]);
		expect(out).not.toContain("localhost");
	});

	test("a credential file is refused inside a batch", async () => {
		const root = project();
		fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=hunter2\n");
		const out = await new ToolExecutor(root).execute("batch", {
			calls: [{ tool: "read_file", args: { path: ".env" } }],
		});
		expect(out).not.toContain("hunter2");
	});
});
