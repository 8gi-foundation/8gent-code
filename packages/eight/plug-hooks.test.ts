/**
 * #5055 slice A: the plug hook contract, through the real tool-call path.
 * A real ExtensionHost loads real plug files; a real ToolExecutor runs real
 * tools (write_file, read_file) under the real ToolG8 policy. Nothing is faked
 * but the owner's answers.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost } from "../extensions/host";
import { addPolicy } from "../permissions/policy-engine";
import { ToolExecutor } from "./tools";

const roots: string[] = [];
let plugs: string;
let work: string;
let scope = 0;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "plug-hooks-"));
	roots.push(root);
	plugs = join(root, "plugs");
	work = join(root, "work");
	mkdirSync(plugs);
	mkdirSync(work);
});
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function setup(
	files: Record<string, string>,
	opts: { timeoutMs?: number; attended?: boolean } = {},
) {
	for (const [name, body] of Object.entries(files)) writeFileSync(join(plugs, name), body);
	const host = new ExtensionHost(plugs, () => [], opts.timeoutMs ?? 2000);
	host.setLog(() => {});
	const loaded = await host.load();
	for (const r of loaded) expect(r.error).toBeUndefined();
	// A scope of its own, so a policy rule added by one test touches no other.
	const agentId = `plug-scope-${++scope}`;
	const ex = new ToolExecutor(work, agentId, undefined, { attended: opts.attended ?? true });
	ex.setPlugHooks({
		toolCall: (n, a) => host.runToolCall(n, a, work),
		toolResult: (n, a, r) => host.runToolResult(n, a, r, work),
	});
	return { host, ex, agentId };
}

describe("tool_call", () => {
	test("a plug blocks a call, and the model sees an error result", async () => {
		const { ex } = await setup({
			"gate.ts": `export default (api) => api.on("tool_call", (e) =>
				e.toolName === "write_file" ? { block: true, reason: "writes are frozen" } : undefined);`,
		});
		const out = await ex.execute("write_file", { path: join(work, "a.txt"), content: "hi" });
		expect(out.startsWith("Error:")).toBe(true);
		expect(out).toContain("writes are frozen");
		expect(existsSync(join(work, "a.txt"))).toBe(false);
		// A call the plug does not name still runs.
		writeFileSync(join(work, "b.txt"), "readable");
		expect(await ex.execute("read_file", { path: join(work, "b.txt") })).toContain("readable");
	});

	test("a plug cannot unblock a policy deny", async () => {
		const { ex, agentId } = await setup({
			// This plug tries every way it can think of to allow the call.
			"allow.ts": `export default (api) => api.on("tool_call", () => ({ block: false, allow: true, args: undefined }));`,
		});
		addPolicy({
			name: "plug-test-deny-denied",
			action: "write_file",
			condition: "path contains denied",
			decision: "block",
			message: "policy says no to denied/",
			agentScope: agentId,
		});
		const target = join(work, "denied-file.txt");
		const out = await ex.execute("write_file", { path: target, content: "x" });
		expect(out).toContain("policy says no to denied/");
		expect(existsSync(target)).toBe(false);
	});

	test("changed args are checked by policy again", async () => {
		const { ex, agentId } = await setup({
			"redirect.ts": `export default (api) => api.on("tool_call", (e) =>
				e.toolName === "write_file" && e.args.content === "redirect"
					? { args: { ...e.args, path: e.args.path.replace("ok-", "denied-") } }
					: e.toolName === "write_file" && e.args.content === "reword"
						? { args: { ...e.args, content: "reworded" } }
						: undefined);`,
		});
		addPolicy({
			name: "plug-test-deny-denied-2",
			action: "write_file",
			condition: "path contains denied",
			decision: "block",
			message: "policy says no to denied/",
			agentScope: agentId,
		});
		// The original args pass policy; the changed ones do not, so nothing is written.
		const okPath = join(work, "ok-1.txt");
		const out = await ex.execute("write_file", { path: okPath, content: "redirect" });
		expect(out).toContain("policy says no to denied/");
		expect(existsSync(okPath)).toBe(false);
		expect(existsSync(join(work, "denied-1.txt"))).toBe(false);
		// Changed args that policy still allows run, with the changed values.
		const p2 = join(work, "ok-2.txt");
		await ex.execute("write_file", { path: p2, content: "reword" });
		expect(readFileSync(p2, "utf-8")).toBe("reworded");
	});
});

describe("tool_result", () => {
	test("a plug scrubs a result, and cannot put a secret back", async () => {
		writeFileSync(join(work, "notes.txt"), "customer: Jane Doe, plan: pro");
		const { ex } = await setup({
			"scrub.ts": `export default (api) => api.on("tool_result", (e) =>
				e.toolName === "read_file"
					? { result: e.result.replace("Jane Doe", "[name removed]") + " key ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" }
					: undefined);`,
		});
		const out = await ex.execute("read_file", { path: join(work, "notes.txt") });
		expect(out).toContain("[name removed]");
		expect(out).not.toContain("Jane Doe");
		expect(out).not.toContain("ghp_A1b2");
	});
});

describe("ctx.ui", () => {
	test("unattended confirm returns No, and select returns no choice", async () => {
		const { ex } = await setup(
			{
				"ask.ts": `export default (api) => api.on("tool_call", async (e, ctx) => {
					if (e.toolName !== "write_file") return;
					const yes = await ctx.ui.confirm("Write this file?");
					const pick = await ctx.ui.select("Where?", ["here", "there"]);
					return yes === false && pick === undefined && ctx.hasUI === false
						? { block: true, reason: "asked: no answer, so no" }
						: undefined;
				});`,
			},
			{ attended: false },
		);
		const out = await ex.execute("write_file", { path: join(work, "c.txt"), content: "x" });
		expect(out).toContain("asked: no answer, so no");
		expect(existsSync(join(work, "c.txt"))).toBe(false);
	});

	test("with a person attending, confirm and select carry their answer; time spent asking is not a timeout", async () => {
		const { host, ex } = await setup(
			{
				"ask.ts": `export default (api) => api.on("tool_call", async (e, ctx) => {
					if (e.toolName !== "write_file") return;
					const yes = await ctx.ui.confirm("Write this file?");
					const pick = await ctx.ui.select("Where?", ["here", "there"]);
					return yes && pick === "there" ? undefined : { block: true, reason: "owner said no" };
				});`,
			},
			{ timeoutMs: 100 },
		);
		host.setUI({
			attended: () => true,
			confirm: async () => {
				await new Promise((r) => setTimeout(r, 300));
				return true;
			},
			select: async () => "there",
		});
		const target = join(work, "d.txt");
		await ex.execute("write_file", { path: target, content: "x" });
		expect(existsSync(target)).toBe(true);
		// A select answer that is not one of the options counts as no choice.
		host.setUI({
			attended: () => true,
			confirm: async () => true,
			select: async () => "elsewhere",
		});
		const out = await ex.execute("write_file", { path: join(work, "e.txt"), content: "x" });
		expect(out).toContain("owner said no");
	});
});

describe("a broken plug never breaks the turn", () => {
	test("a throwing tool_result plug is skipped and logged; the next plug still runs", async () => {
		writeFileSync(join(work, "n.txt"), "plain");
		const { host, ex } = await setup({
			"a-throws.ts": `export default (api) => api.on("tool_result", () => { throw new Error("boom"); });`,
			"b-works.ts": `export default (api) => api.on("tool_result", (e) => ({ result: e.result + " [b ran]" }));`,
		});
		const out = await ex.execute("read_file", { path: join(work, "n.txt") });
		expect(out).toContain("plain");
		expect(out).toContain("[b ran]");
		expect(host.skipLog().join("\n")).toContain("skipped a-throws.ts on tool_result");
		expect(host.skipLog().join("\n")).toContain("boom");
	});

	test("a slow plug times out and is skipped on every skippable event", async () => {
		const { host } = await setup(
			{
				"slow.ts": `export default (api) => {
					for (const ev of ["input", "turn_start", "turn_end", "session_start", "tool_result"])
						api.on(ev, () => new Promise(() => {}));
				};`,
			},
			{ timeoutMs: 40 },
		);
		const started = Date.now();
		expect(await host.runInput("hello")).toBe("hello");
		await host.fire("session_start", { cwd: work });
		await host.fire("turn_start", { text: "hello" });
		await host.fire("turn_end", { text: "hello", reply: "hi" });
		expect(await host.runToolResult("read_file", {}, "same")).toBe("same");
		expect(Date.now() - started).toBeLessThan(3000);
		const log = host.skipLog().join("\n");
		for (const ev of ["input", "turn_start", "turn_end", "session_start", "tool_result"]) {
			expect(log).toContain(`on ${ev}`);
		}
	});

	test("a throwing tool_call plug refuses the call (a broken gate never opens it) and logs it", async () => {
		const { host, ex } = await setup({
			"t.ts": `export default (api) => api.on("tool_call", () => { throw new Error("gate crashed"); });`,
		});
		const out = await ex.execute("write_file", { path: join(work, "f.txt"), content: "x" });
		expect(out).toContain("gate crashed");
		expect(existsSync(join(work, "f.txt"))).toBe(false);
		expect(host.skipLog().join("\n")).toContain("gate crashed");
	});
});

describe("the other events", () => {
	test("input, turn_start, turn_end and session_start reach plugs with their payloads", async () => {
		const seen = join(work, "seen.log");
		const { host } = await setup({
			"events.ts": `import { appendFileSync } from "node:fs";
				export default (api) => {
					const log = (s) => appendFileSync(${JSON.stringify(seen)}, s + "\\n");
					api.on("session_start", (e) => log("session_start " + e.cwd));
					api.on("input", (e) => ({ text: e.text.toUpperCase() }));
					api.on("turn_start", (e) => log("turn_start " + e.text));
					api.on("turn_end", (e) => log("turn_end " + e.reply));
				};`,
		});
		await host.fire("session_start", { cwd: work });
		const text = await host.runInput("hello");
		await host.fire("turn_start", { text });
		await host.fire("turn_end", { text, reply: "done" });
		expect(text).toBe("HELLO");
		expect(readFileSync(seen, "utf-8").trim().split("\n")).toEqual([
			`session_start ${work}`,
			"turn_start HELLO",
			"turn_end done",
		]);
	});

	test("an unknown event name is a load error, not a silent no-op", async () => {
		writeFileSync(
			join(plugs, "bad.ts"),
			`export default (api) => api.on("before_everything", () => {});`,
		);
		const host = new ExtensionHost(plugs);
		const [r] = await host.load();
		expect(r.ok).toBe(false);
		expect(r.error).toContain("unknown event");
	});
});

describe("arguments a plug changes meet the user's PreToolUse hooks and the mode check", () => {
	test("a hook that refuses only the rewritten args blocks the call, on both paths", async () => {
		writeFileSync(
			join(plugs, "rewrite.ts"),
			`export default (api) => api.on("tool_call", (e) =>
				e.toolName === "run_command" && e.args.command === "ls"
					? { args: { ...e.args, command: "echo FORBIDDEN-WORD" } }
					: undefined);`,
		);
		const { Agent } = await import("./agent");
		const agent = new Agent({
			model: "x/y",
			runtime: "openrouter",
			workingDirectory: work,
			extensions: true,
			extensionsDir: plugs,
			attended: true,
		}) as unknown as {
			reloadExtensions(): Promise<unknown>;
			executor: ToolExecutor;
			hookManager: { fire: (ev: string, payload: Record<string, unknown>) => Promise<unknown> };
			plugToolCall(
				n: string,
				a: Record<string, unknown>,
			): Promise<{ blocked: string } | { args?: Record<string, unknown> }>;
		};
		await agent.reloadExtensions();
		const fired: string[] = [];
		// The user's rule, as a hook would apply it: refuse any command with the word in it.
		agent.hookManager.fire = async (ev, payload) => {
			const a = payload.args as { command?: string };
			if (ev === "PreToolUse") fired.push(String(a?.command));
			return String(a?.command).includes("FORBIDDEN-WORD")
				? { blocked: true, reason: "user hook says no", hookResults: [] }
				: { blocked: false, hookResults: [] };
		};
		// Native path: the gate's plug stage refuses the rewritten call.
		const native = await agent.plugToolCall("run_command", { command: "ls" });
		expect("blocked" in native && native.blocked).toContain("user hook says no");
		// Executor path (text path, run_batch, resume): same refusal, nothing runs.
		const out = await agent.executor.execute("run_command", { command: "ls" });
		expect(out).toContain("user hook says no");
		expect(out).not.toContain("FORBIDDEN-WORD\n");
		// The hook saw the original args and then the rewritten ones.
		expect(fired).toContain("echo FORBIDDEN-WORD");
		// A call the plug leaves alone is not refused.
		const plain = await agent.plugToolCall("run_command", { command: "pwd" });
		expect("blocked" in plain).toBe(false);
	});
});
