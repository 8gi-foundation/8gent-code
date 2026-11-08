import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BATCH_MAX_CALLS } from "./batch-read";
import { ToolExecutor } from "./tools";

const made: string[] = [];
afterAll(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** An executor with a pass-through item gate, as an owner with no refusals would install. */
function gated(root: string) {
	const ex = new ToolExecutor(root);
	ex.setItemGate(async () => ({ refusal: null }));
	return ex;
}

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
		const ex = gated(project());
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
		const ex = gated(root);
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
		const ex = gated(project());
		const many = Array.from({ length: BATCH_MAX_CALLS + 1 }, () => ({
			tool: "read_file",
			args: { path: "a.txt" },
		}));
		expect(await ex.execute("batch", { calls: many })).toContain(`at most ${BATCH_MAX_CALLS}`);
		expect(await ex.execute("batch", { calls: [] })).toContain("needs calls");
	});

	test("a path outside the workspace is refused as on its own; sibling calls still run", async () => {
		const ex = gated(project());
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
		const out = await gated(root).execute("batch", {
			calls: [{ tool: "read_file", args: { path: ".env" } }],
		});
		expect(out).not.toContain("hunter2");
	});
});

describe("batch fails closed without an item gate", () => {
	test("a bare executor runs nothing", async () => {
		const out = await new ToolExecutor(project()).execute("batch", {
			calls: [{ tool: "read_file", args: { path: "a.txt" } }],
		});
		expect(out).toContain("batch has no per-item gate");
		expect(out).toContain("Nothing was run");
		expect(out).not.toContain("alpha line");
	});
});

// The owner's gate (agent.ts setItemGate) on the real Agent: each inner call meets the
// mode's tool set, the YAML PreToolUse hooks, the privacy gate and the session log (8SO HOLD, #76).
describe("inner calls take the agent's item gate", () => {
	const saved: Record<string, string | undefined> = {};
	const setEnv = (k: string, v: string) => {
		if (!(k in saved)) saved[k] = process.env[k];
		process.env[k] = v;
	};
	afterEach(async () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
			delete saved[k];
		}
		(await import("./modes")).resetModeManager();
		(await import("../hooks")).resetHookManager();
	});

	type AgentInternals = {
		executor: ToolExecutor;
		turnProvider?: { name: string; model: string; apiKey?: string };
		recentFilePaths: string[];
		sessionWriter: { writeToolCall: (row: { toolCallId: string; name: string }, ...r: unknown[]) => void };
	};
	const mk = async (root: string, runtime = "ollama") => {
		const { Agent } = await import("./agent");
		return new Agent({ model: "x/y", runtime, workingDirectory: root } as never) as unknown as AgentInternals;
	};

	test("a mode's deniedTools entry blocks that tool inside a batch; the others still run", async () => {
		const root = project();
		const data = fs.mkdtempSync(path.join(os.tmpdir(), "batch-modes-"));
		made.push(data);
		fs.writeFileSync(path.join(data, "modes.yaml"), "modes:\n  nolist:\n    deniedTools: [list_files]\n");
		setEnv("EIGHT_DATA_DIR", data);
		const modes = await import("./modes");
		modes.resetModeManager();
		expect(modes.getModeManager().setActiveMode("nolist")).toBe(true);
		const a = await mk(root);
		const out = await a.executor.execute("batch", {
			calls: [
				{ tool: "read_file", args: { path: "a.txt" } },
				{ tool: "list_files", args: {} },
			],
		});
		expect(out).toContain("alpha line");
		expect(out).toContain("[2/2 list_files]\nError: list_files is not available in nolist mode");
		expect(out).not.toContain("b.txt");
	});

	test("a YAML PreToolUse hook that denies is honoured inside a batch", async () => {
		const root = project();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "batch-hooks-"));
		made.push(home);
		const script = path.join(home, "block.sh").replace(/\\/g, "/");
		fs.writeFileSync(script, `echo '{"block": true, "reason": "searches are frozen"}'\n`);
		const hooks = path.join(home, "hooks.yaml");
		fs.writeFileSync(hooks, `- event: PreToolUse\n  matcher: search_files\n  command: sh ${script}\n`);
		setEnv("EIGHT_HOOKS_YAML", hooks);
		(await import("../hooks")).resetHookManager();
		const a = await mk(root);
		const out = await a.executor.execute("batch", {
			calls: [
				{ tool: "read_file", args: { path: "a.txt" } },
				{ tool: "search_files", args: { pattern: "beta" } },
			],
		});
		expect(out).toContain("alpha line");
		expect(out).toContain('Hook blocked tool "search_files": searches are frozen');
		expect(out).not.toContain("b.txt:1");
	});

	test("a .env read inside a batch on a hosted provider forces the turn local", async () => {
		const root = project();
		fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=hunter2\n");
		const a = await mk(root, "openrouter");
		a.turnProvider = { name: "openrouter", model: "x/y", apiKey: "k" };
		const out = await a.executor.execute("batch", {
			calls: [{ tool: "read_file", args: { path: ".env" } }],
		});
		expect(out).not.toContain("hunter2");
		expect(a.recentFilePaths).toContain(".env");
		expect(a.turnProvider?.name).not.toBe("openrouter");
		expect(a.turnProvider?.apiKey).toBeUndefined();
	});

	test("each inner call writes its own session row", async () => {
		const a = await mk(project());
		const rows: { id: string; name: string }[] = [];
		const real = a.sessionWriter.writeToolCall.bind(a.sessionWriter);
		a.sessionWriter.writeToolCall = (row, ...r) => {
			rows.push({ id: row.toolCallId, name: row.name });
			real(row, ...r);
		};
		await a.executor.execute("batch", {
			calls: [
				{ tool: "read_file", args: { path: "a.txt" } },
				{ tool: "read_file", args: { path: "b.txt" } },
				{ tool: "list_files", args: {} },
			],
		});
		expect(rows.map((r) => r.name).sort()).toEqual(["list_files", "read_file", "read_file"]);
		expect(new Set(rows.map((r) => r.id)).size).toBe(3);
	});
});
