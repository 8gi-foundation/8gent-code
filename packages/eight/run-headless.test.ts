import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModeManager } from "./modes";
import { type RunEvent, validateRunEvent } from "./run-events";
import { defaultRunSessionStore } from "./run-session";
import { combinePromptAndStdin, continueTarget, headlessRoute, parseRunArgs } from "./run";

describe("headless flags", () => {
	test("-p with a prompt, --mode json, --tools, session flags", () => {
		const o = parseRunArgs([
			"-p",
			"--mode",
			"json",
			"--tools",
			"read_file, grep",
			"--no-session",
			"--session-dir=/x",
			"--continue",
			"review",
			"this",
		]);
		expect(o.print).toBe(true);
		expect(o.outputFormat).toBe("stream-json");
		expect(o.tools).toEqual(["read_file", "grep"]);
		expect(o.noSession).toBe(true);
		expect(o.sessionDir).toBe("/x");
		expect(o.continueLatest).toBe(true);
		expect(o.prompt).toBe("review this");
	});
	test("old run flags still parse", () => {
		const o = parseRunArgs(["--yes", "--output-format", "stream-json", "hi"]);
		expect(o.outputFormat).toBe("stream-json");
		expect(o.print).toBe(false);
		expect(o.continueLatest).toBe(false);
	});
});

describe("stdin", () => {
	test("piped text goes ahead of the instruction", () => {
		expect(combinePromptAndStdin("review", "diff --git a b\n")).toBe("diff --git a b\n\nreview");
	});
	test("no pipe leaves the prompt; pipe alone is the prompt", () => {
		expect(combinePromptAndStdin("review", "  \n")).toBe("review");
		expect(combinePromptAndStdin("", "just this")).toBe("just this");
	});
});

describe("routing", () => {
	test("routes -p, --mode, and leaves subcommands alone", () => {
		expect(headlessRoute(["-p", "x"])).toBe("run");
		expect(headlessRoute(["--print", "x"])).toBe("run");
		expect(headlessRoute(["--mode", "json", "x"])).toBe("run");
		expect(headlessRoute(["--mode=rpc"])).toBe("rpc");
		expect(headlessRoute(["chat", "-p", "x"])).toBeNull();
		expect(headlessRoute([])).toBeNull();
		expect(headlessRoute(["--resume"])).toBeNull();
	});
	test("--continue with and without an id", () => {
		expect(continueTarget(["--model=x"])).toBeNull();
		expect(continueTarget(["--continue"])).toEqual({ rest: [] });
		expect(continueTarget(["--continue", "--fast"])).toEqual({ rest: ["--fast"] });
		expect(continueTarget(["--continue", "abc", "--fast"])).toEqual({
			id: "abc",
			rest: ["--fast"],
		});
	});
});

describe("event types", () => {
	const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
	const good: RunEvent[] = [
		{
			type: "session_start",
			session_id: "run-1",
			started_at: "t",
			provider: "ollama",
			model: "m",
			cwd: "/",
			resumed: false,
			persisted: true,
		},
		{
			type: "tool_use",
			subtype: "start",
			tool_call_id: "a",
			tool_name: "read_file",
			step: 0,
			input: {},
		},
		{
			type: "tool_result",
			subtype: "ok",
			tool_call_id: "a",
			tool_name: "read_file",
			step: null,
			success: true,
			duration_ms: 4,
			result_preview: "",
		},
		{ type: "assistant", subtype: "text", step: 1, finish_reason: "stop", text: "hi", usage },
		{
			type: "assistant",
			subtype: "tool_calls",
			step: 1,
			finish_reason: "tool-calls",
			tool_calls: [{ toolName: "x", toolCallId: "y" }],
			usage,
		},
		{ type: "result", subtype: "ok", session_id: "run-1", ended_at: "t", final_text: "done" },
		{ type: "error", subtype: "usage", message: "no" },
	];
	test("every documented event validates", () => {
		for (const e of good) expect(validateRunEvent(JSON.parse(JSON.stringify(e)))).toEqual([]);
	});
	test("a malformed or unknown event is reported", () => {
		expect(validateRunEvent({ type: "result", subtype: "ok" }).length).toBeGreaterThan(0);
		expect(validateRunEvent({ type: "nope" })[0]).toContain("unknown event");
		expect(validateRunEvent("x")).toEqual(["event is not an object"]);
	});
});

describe("folder sessions", () => {
	test("latestForCwd picks the newest session of that folder only", async () => {
		const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "run-sess-"));
		const store = defaultRunSessionStore(dir);
		const meta = (cwd: string) => ({ model: "m", provider: "p", cwd });
		store.save("run-1", [{ role: "user", content: "a" }], meta("/work/a"));
		await Bun.sleep(5);
		store.save("run-2", [{ role: "user", content: "b" }], meta("/work/b"));
		await Bun.sleep(5);
		store.save("run-3", [{ role: "user", content: "c" }], meta("/work/a"));
		await Bun.sleep(5);
		store.save("run-4", [{ role: "user", content: "d" }], meta("/work/b"));
		expect(store.latestForCwd("/work/a")?.id).toBe("run-3");
		expect(store.latestForCwd("/work/b/")?.id).toBe("run-4");
		expect(store.latestForCwd("/work/none")).toBeNull();
		expect(store.load("run-3")?.messages[0].content).toBe("c");
	});
});

describe("--tools", () => {
	test("only the named tools pass the mode filter", () => {
		const mm = new ModeManager(path.join(os.tmpdir(), "no-modes.yaml"));
		mm.applyToolAllowlist(["read_file", "grep"]);
		expect(mm.isToolAllowed("read_file")).toBe(true);
		expect(mm.isToolAllowed("run_command")).toBe(false);
		expect(mm.filterTools([{ name: "grep" }, { name: "write_file" }])).toEqual([{ name: "grep" }]);
	});
});
