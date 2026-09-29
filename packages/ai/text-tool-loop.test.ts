import { describe, expect, test } from "bun:test";
import {
	CONTINUE_MESSAGE,
	NOT_FINAL_MAX_CHARS,
	isShellFileWrite,
	isUnfinishedReply,
	runTextToolAgent,
	type TextTool,
} from "./text-tool-loop";
import type { TextToolMessage } from "./text-tool-client";

const READ_FILE_TOOL: TextTool = {
	spec: {
		name: "read_file",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	run: async () => "fixed file contents: secret is 4242",
};

describe("runTextToolAgent", () => {
	test("executes a tool, feeds the result back, returns final prose", async () => {
		// First call: emit a read_file tool_call. Second call: prose answer.
		let turn = 0;
		const call = async (_messages: TextToolMessage[]): Promise<string> => {
			turn++;
			if (turn === 1) {
				return [
					"Let me read it.",
					"```tool_call",
					'{"name": "read_file", "arguments": {"path": "/tmp/x.txt"}}',
					"```",
				].join("\n");
			}
			return "The secret number is 4242.";
		};

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "What is the secret?" }],
			tools: [READ_FILE_TOOL],
			call,
		});

		expect(result.content).toBe("The secret number is 4242.");
		expect(result.rounds).toBe(2);
		expect(result.toolLog).toHaveLength(1);
		expect(result.toolLog[0].name).toBe("read_file");
		expect(result.toolLog[0].args).toEqual({ path: "/tmp/x.txt" });
		expect(result.toolLog[0].result).toContain("4242");
	});

	test("stops at maxRounds when the model never stops calling tools", async () => {
		let calls = 0;
		const call = async (): Promise<string> => {
			calls++;
			return [
				"```tool_call",
				'{"name": "read_file", "arguments": {"path": "/loop"}}',
				"```",
			].join("\n");
		};

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [READ_FILE_TOOL],
			call,
			maxRounds: 3,
		});

		expect(result.rounds).toBe(3);
		expect(calls).toBe(3);
		expect(result.toolLog).toHaveLength(3);
	});

	test("a throwing tool does not break the loop", async () => {
		const throwing: TextTool = {
			spec: { name: "boom", description: "throws", parameters: {} },
			run: async () => {
				throw new Error("kaboom");
			},
		};
		let turn = 0;
		const call = async (): Promise<string> => {
			turn++;
			if (turn === 1) {
				return [
					"```tool_call",
					'{"name": "boom", "arguments": {}}',
					"```",
				].join("\n");
			}
			return "Handled the error gracefully.";
		};

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [throwing],
			call,
		});

		expect(result.content).toBe("Handled the error gracefully.");
		expect(result.toolLog).toHaveLength(1);
		expect(result.toolLog[0].result).toContain("kaboom");
	});
});

describe("runTextToolAgent - cut-off tool_call", () => {
	test("a truncated tool_call is fed back as an error and the loop continues", async () => {
		const writes: Array<Record<string, unknown>> = [];
		const WRITE_TOOL: TextTool = {
			spec: { name: "write_file", description: "Write a file", parameters: {} },
			run: async (args) => {
				writes.push(args);
				return "File written";
			},
		};
		const full = JSON.stringify({
			name: "write_file",
			arguments: { path: "deck/outline.md", content: "# Outline \u2014 slide 1\n- `state` -> answers\n".repeat(40) },
		});
		const seen: TextToolMessage[][] = [];
		let turn = 0;
		const call = async (messages: TextToolMessage[]): Promise<string> => {
			seen.push(messages);
			turn++;
			// Round 1: the reply stops mid-string, as when it hits max tokens.
			if (turn === 1) return ["```tool_call", full.slice(0, 900)].join("\n");
			if (turn === 2) {
				return [
					"```tool_call",
					'{"name": "write_file", "arguments": {"path": "deck/outline.md", "content": "# part 1"}}',
					"```",
				].join("\n");
			}
			return "Wrote the outline.";
		};

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write the outline" }],
			tools: [WRITE_TOOL],
			call,
		});

		expect(result.rounds).toBe(3);
		expect(result.content).toBe("Wrote the outline.");
		expect(writes).toEqual([{ path: "deck/outline.md", content: "# part 1" }]);
		const feedback = seen[1][seen[1].length - 1].content;
		expect(feedback).toContain("write_file");
		expect(feedback).toMatch(/cut off/i);
		expect(feedback).toMatch(/token limit/i);
		expect(feedback).toMatch(/smaller parts/i);
		expect(feedback).not.toContain("Unterminated string");
		// The partial JSON never leaks out as the "final answer".
		expect(result.content).not.toContain('"arguments"');
	});

	test("a cut-off call on the last round returns the error, not raw JSON", async () => {
		const call = async (): Promise<string> =>
			'```tool_call\n{"name": "write_file", "arguments": {"path": "a.md", "content": "abc';
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [READ_FILE_TOOL],
			call,
			maxRounds: 1,
		});
		expect(result.content).toMatch(/cut off/i);
		expect(result.content).not.toContain('"arguments"');
	});
});

describe("isShellFileWrite", () => {
	test("flags echo/printf/cat into a redirect", () => {
		expect(isShellFileWrite("echo 'hi' > /tmp/out.txt")).toBe(true);
		expect(isShellFileWrite("printf 'hi' >> log.txt")).toBe(true);
		expect(isShellFileWrite("cat foo > bar.txt")).toBe(true);
	});

	test("flags a pipe into tee and a here-doc redirect", () => {
		expect(isShellFileWrite("echo hi | tee out.txt")).toBe(true);
		expect(isShellFileWrite("cat <<EOF > out.txt\nhi\nEOF")).toBe(true);
	});

	test("does NOT flag plain mkdir, ls, or fd redirection", () => {
		expect(isShellFileWrite("mkdir -p /tmp/dogfood")).toBe(false);
		expect(isShellFileWrite("ls -la /tmp")).toBe(false);
		expect(isShellFileWrite("some-cmd 2>&1")).toBe(false);
		expect(isShellFileWrite("grep foo bar.txt")).toBe(false);
	});

	test("ignores non-string commands", () => {
		expect(isShellFileWrite(undefined)).toBe(false);
		expect(isShellFileWrite(42)).toBe(false);
		expect(isShellFileWrite("")).toBe(false);
	});
});

// ── Continue until every requested step is done (Rishi pilot, l2-solo-deck) ──
//
// Replays the pilot fault: ollama qwen3.8:27b-mlx researched, wrote
// deck/outline.md, then replied only "Now let me write the Marp-style deck:"
// and the turn ended "ok" with deck.md never written.

type Script = Array<string | ((messages: TextToolMessage[]) => string)>;

function tc(name: string, args: Record<string, unknown>): string {
	return ["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");
}

/** A scripted fake model: returns the next scripted reply per call. */
function scriptedModel(script: Script) {
	const seen: TextToolMessage[][] = [];
	let i = 0;
	const call = async (messages: TextToolMessage[]): Promise<string> => {
		seen.push(messages);
		const step = script[Math.min(i, script.length - 1)];
		i++;
		return typeof step === "function" ? step(messages) : step;
	};
	return { call, seen, calls: () => i };
}

/** A tiny fake workspace: write_file, read_file, list_files, run_command. */
function fakeWorkspace() {
	const files = new Map<string, string>([["packages/decide/README.md", "# Eight System One"]]);
	const commands: string[] = [];
	const tools: TextTool[] = [
		{
			spec: { name: "read_file", description: "Read a file", parameters: {} },
			run: async (a) => {
				const f = files.get(String(a.path));
				if (f === undefined) throw new Error(`no such file ${a.path}`);
				return f;
			},
		},
		{
			spec: { name: "write_file", description: "Write a file", parameters: {} },
			run: async (a) => {
				files.set(String(a.path), String(a.content));
				return `Wrote ${a.path}`;
			},
		},
		{
			spec: { name: "run_command", description: "Run a command", parameters: {} },
			run: async (a) => {
				const cmd = String(a.command);
				commands.push(cmd);
				if (cmd === "ls deck") {
					return [...files.keys()]
						.filter((p) => p.startsWith("deck/"))
						.map((p) => p.slice(5))
						.join("\n");
				}
				if (cmd === "wc -l deck/deck.md") {
					const f = files.get("deck/deck.md");
					if (f === undefined) return "Error: wc: deck/deck.md: No such file";
					return `${f.split("\n").length} deck/deck.md`;
				}
				return "";
			},
		},
	];
	return { files, commands, tools };
}

const FIVE_STEP_TASK =
	"Research packages/decide, then write deck/outline.md, then turn it into deck/deck.md, then run ls deck and wc -l deck/deck.md, then summarise.";

const lastUserMessage = (msgs: TextToolMessage[]) =>
	[...msgs].reverse().find((m) => m.role === "user")?.content ?? "";

describe("runTextToolAgent - continue until every step is done", () => {
	test("5-step task: an announced-but-untaken step is continued and the task finishes", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What\n2. Why" }),
			// The pilot fault: announces the next step, takes no action.
			"Now let me write the Marp-style deck:",
			tc("write_file", { path: "deck/deck.md", content: "# What\n---\n# Why" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"Done. Researched the package, wrote deck/outline.md and deck/deck.md (3 lines).",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(ws.files.has("deck/deck.md")).toBe(true);
		expect(ws.commands).toEqual(["ls deck", "wc -l deck/deck.md"]);
		expect(result.content).toStartWith("Done.");
		expect(result.rounds).toBe(7);
		expect(result.toolLog.map((t) => t.name)).toEqual([
			"read_file",
			"write_file",
			"write_file",
			"run_command",
			"run_command",
		]);
		// Exactly one continuation message was sent, right after the announcement.
		const continuations = model.seen.filter((m) => lastUserMessage(m) === CONTINUE_MESSAGE);
		expect(continuations).toHaveLength(1);
		expect(model.seen[3][model.seen[3].length - 2]).toEqual({
			role: "assistant",
			content: "Now let me write the Marp-style deck:",
		});
	});

	test("does not loop forever: a model that keeps announcing gets ONE continuation, then the turn ends", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Now let me write the deck:",
			"Now let me write the deck:",
			"Now let me write the deck:",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.calls()).toBe(3);
		expect(result.rounds).toBe(3);
		expect(result.content).toBe("Now let me write the deck:");
		expect(ws.files.has("deck/deck.md")).toBe(false);
	});

	test("at most once per turn, even when the model works in between", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Next, the deck:",
			tc("write_file", { path: "deck/deck.md", content: "y" }),
			"Now I will run the checks:",
			tc("run_command", { command: "ls deck" }),
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.calls()).toBe(4);
		expect(result.content).toBe("Now I will run the checks:");
		expect(ws.commands).toEqual([]);
	});

	test("the continuation spends a round: maxRounds is still the hard cap", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Now let me write the deck:",
			tc("write_file", { path: "deck/deck.md", content: "y" }),
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 2,
		});

		expect(model.calls()).toBe(2);
		expect(result.rounds).toBe(2);
		expect(result.content).toBe("Now let me write the deck:");
	});

	test("a real final answer after a tool round ends the turn with no continuation", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"The package is called Eight System One.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "What is the package called?" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("The package is called Eight System One.");
	});

	test("a genuine question to the user ends the turn with no continuation", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"Should the deck have 5 or 10 slides?",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "make a deck" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("Should the deck have 5 or 10 slides?");
	});

	test("a colon-ended reply with no preceding tool round is a final answer", async () => {
		const model = scriptedModel(["Here are the options:", "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "hi" }],
			tools: [READ_FILE_TOOL],
			call: model.call,
		});
		expect(model.calls()).toBe(1);
		expect(result.content).toBe("Here are the options:");
	});

	test("no continuation after a round whose every tool call failed", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "missing.md" }),
			"Let me try another way:",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read it" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("Let me try another way:");
	});

	test("a long colon-ended reply carries substance and is treated as final", async () => {
		const ws = fakeWorkspace();
		const long = `${"I researched the package and wrote the outline and the deck. ".repeat(6)}Files written:`;
		expect(long.length).toBeGreaterThan(NOT_FINAL_MAX_CHARS);
		const model = scriptedModel([tc("read_file", { path: "packages/decide/README.md" }), long, "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe(long);
	});

	test("a cut-off round in between means the reply no longer follows a successful tool round", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			'```tool_call\n{"name": "write_file", "arguments": {"path": "deck/deck.md", "content": "abc',
			"Here is where I got to:",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(3);
		expect(result.content).toBe("Here is where I got to:");
	});

	test("an empty reply right after a tool round is continued once", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"",
			"It is called Eight System One.",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "What is it called?" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(3);
		expect(result.content).toBe("It is called Eight System One.");
	});
});

describe("isUnfinishedReply", () => {
	test("short colon-terminated lead-ins and empty replies are unfinished", () => {
		expect(isUnfinishedReply("Now let me write the Marp-style deck:")).toBe(true);
		expect(isUnfinishedReply("Next step:  \n")).toBe(true);
		expect(isUnfinishedReply("")).toBe(true);
		expect(isUnfinishedReply("   \n")).toBe(true);
	});

	test("replies ending in any other way are final", () => {
		expect(isUnfinishedReply("Done. Wrote deck/deck.md.")).toBe(false);
		expect(isUnfinishedReply("Which theme do you want?")).toBe(false);
		expect(isUnfinishedReply("Let me write the deck")).toBe(false);
		expect(isUnfinishedReply(`${"x".repeat(NOT_FINAL_MAX_CHARS)}:`)).toBe(false);
	});
});

describe("follow-up instruction after a tool round", () => {
	test("tells the model to keep calling tools until every step is done, and no longer invites an early stop", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([tc("read_file", { path: "packages/decide/README.md" }), "All done."]);
		await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: ws.tools,
			call: model.call,
		});
		const followUp = lastUserMessage(model.seen[1]);
		expect(followUp).toContain("Tool read_file returned:");
		expect(followUp).not.toContain("If you have enough information");
		expect(followUp).toMatch(/every step/i);
		expect(followUp).toMatch(/tool_call/);
		expect(followUp).toMatch(/question/i);
	});
});
