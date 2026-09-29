import { describe, expect, test } from "bun:test";
import {
	COMPLETION_CHECK_MESSAGE,
	DONE_MARKER,
	isQuestionToUser,
	isShellFileWrite,
	runTextToolAgent,
	stripDoneMarker,
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
		// Round 3 is the one completion check after the successful tool round.
		expect(result.rounds).toBe(3);
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

		// Round 4 is the one completion check after the successful write.
		expect(result.rounds).toBe(4);
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
		// Exactly one completion check was sent, right after the announcement.
		const continuations = model.seen.filter((m) => lastUserMessage(m) === COMPLETION_CHECK_MESSAGE);
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

		// One continuation, then one claim follow-up (ls deck and wc never ran),
		// then the turn ends with both contradictions noted for the user.
		expect(model.calls()).toBe(4);
		expect(result.rounds).toBe(4);
		expect(result.content).toBe(
			"Now let me write the deck:\n\n[harness] Not verified: 'ls deck' was requested but never ran.\n[harness] Not verified: 'wc -l deck/deck.md' was requested but never ran.",
		);
		expect(result.unverified).toHaveLength(2);
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
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"Ran ls deck and wc -l deck/deck.md.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// The completion check is spent on "Next, the deck:"; the second
		// announcement ends as a final answer, so the claim check (a separate,
		// also once-per-turn follow-up) sends the unrun commands back.
		expect(model.seen.filter((m) => lastUserMessage(m) === COMPLETION_CHECK_MESSAGE)).toHaveLength(1);
		expect(model.calls()).toBe(7);
		expect(ws.commands).toEqual(["ls deck", "wc -l deck/deck.md"]);
		expect(result.content).toBe("Ran ls deck and wc -l deck/deck.md.");
		expect(result.unverified).toEqual([]);
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
		// No round left for any follow-up: the contradictions are noted instead.
		expect(result.content).toBe(
			"Now let me write the deck:\n\n[harness] Not verified: 'ls deck' was requested but never ran.\n[harness] Not verified: 'wc -l deck/deck.md' was requested but never ran.",
		);
	});

	test("a real final answer after a tool round costs one short check round, then ends", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"The package is called Eight System One.",
			"DONE: The package is called Eight System One.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "What is the package called?" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(3);
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

	test("reply length and ending do not matter: a long report is checked once like any other", async () => {
		const ws = fakeWorkspace();
		const long = `${"I researched the package and wrote the outline and the deck. ".repeat(6)}Files written:`;
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			long,
			`${DONE_MARKER} ${long}`,
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(3);
		expect(result.content).toBe(long);
	});

	test("a bare marker answer to the check keeps the summary the model gave before it", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Wrote deck/outline.md.",
			"DONE:",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write the outline" }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(3);
		expect(result.content).toBe("Wrote deck/outline.md.");
	});

	test("a cut-off round in between means the reply no longer follows a successful tool round", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			'```tool_call\n{"name": "write_file", "arguments": {"path": "deck/deck.md", "content": "abc',
			"Here is where I got to:",
			"Here is where I got to:",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
		});
		// No completion check (the round before was cut off), but the claim
		// check still sends its one follow-up: ls deck and wc never ran.
		expect(model.seen.filter((m) => lastUserMessage(m) === COMPLETION_CHECK_MESSAGE)).toHaveLength(0);
		expect(model.calls()).toBe(4);
		expect(result.content).toStartWith("Here is where I got to:\n\n[harness] Not verified: 'ls deck'");
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

describe("isQuestionToUser", () => {
	test("a reply whose last non-space character is ? is a question", () => {
		expect(isQuestionToUser("Which theme do you want?")).toBe(true);
		expect(isQuestionToUser("Outline written. Marp or reveal.js?  \n")).toBe(true);
	});

	test("any other ending is not a question", () => {
		expect(isQuestionToUser("Now creating the Marp deck from the outline.")).toBe(false);
		expect(isQuestionToUser("Now let me write the Marp-style deck:")).toBe(false);
		expect(isQuestionToUser("")).toBe(false);
		expect(isQuestionToUser("Is it done? Yes, it is.")).toBe(false);
	});
});

describe("stripDoneMarker", () => {
	test("removes a leading marker, plain or in markdown bold", () => {
		expect(stripDoneMarker("DONE: Wrote deck/deck.md.")).toBe("Wrote deck/deck.md.");
		expect(stripDoneMarker("  DONE:\nWrote it.")).toBe("Wrote it.");
		expect(stripDoneMarker("**DONE:** Wrote it.")).toBe("Wrote it.");
		expect(stripDoneMarker("**DONE**: Wrote it.")).toBe("Wrote it.");
		expect(stripDoneMarker("DONE:")).toBe("");
	});

	test("leaves everything else alone, including the marker mid-text", () => {
		expect(stripDoneMarker("Wrote it.")).toBe("Wrote it.");
		expect(stripDoneMarker("Done. Wrote it.")).toBe("Done. Wrote it.");
		expect(stripDoneMarker("Status DONE: all good")).toBe("Status DONE: all good");
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

// ── Completion check (Rishi pilot run 2026-09-29_141338, l2-solo-deck) ──────
//
// On main with #3008, qwen3.8:27b-mlx wrote deck/outline.md, then replied
// "Now creating the Marp deck from the outline." with no tool call. It ended in
// "." so the colon rule never fired and 2 of 5 steps were never done.
// Punctuation is not a signal; the loop now asks once whether every step is done.

const isCheck = (msgs: TextToolMessage[]) => lastUserMessage(msgs) === COMPLETION_CHECK_MESSAGE;

describe("runTextToolAgent - completion check", () => {
	test("the pilot reply 'Now creating the Marp deck from the outline.' is checked and all 5 steps finish", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What\n2. Why" }),
			"Now creating the Marp deck from the outline.",
			tc("write_file", { path: "deck/deck.md", content: "# What\n---\n# Why" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"Researched the package, wrote deck/outline.md and deck/deck.md, listed deck, counted 3 lines.",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(ws.files.get("deck/deck.md")).toBe("# What\n---\n# Why");
		expect(ws.commands).toEqual(["ls deck", "wc -l deck/deck.md"]);
		expect(result.toolLog.map((t) => t.name)).toEqual([
			"read_file",
			"write_file",
			"write_file",
			"run_command",
			"run_command",
		]);
		expect(result.rounds).toBe(7);
		expect(result.content).toStartWith("Researched the package");
		// Exactly one check, sent straight after the period-ended announcement.
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(isCheck(model.seen[3])).toBe(true);
	});

	test("a model that did finish gets exactly one check, answers DONE, and the turn ends with the marker stripped", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Wrote deck/outline.md with five slides.",
			"DONE: Wrote deck/outline.md with five slides.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write deck/outline.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.calls()).toBe(3);
		expect(result.rounds).toBe(3);
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Wrote deck/outline.md with five slides.");
	});

	test("no infinite loop: a model that keeps announcing with a period gets one check, then the turn ends", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Now creating the Marp deck from the outline.",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// One completion check, one claim follow-up, then the turn ends noted.
		expect(model.calls()).toBe(4);
		expect(result.rounds).toBe(4);
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toStartWith("Now creating the Marp deck from the outline.\n\n[harness] Not verified:");
		expect(result.unverified).toHaveLength(2);
		expect(ws.files.has("deck/deck.md")).toBe(false);
	});

	test("a question to the user after a tool round is not checked", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Outline written. Do you want the deck in Marp or reveal.js?",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "make a deck" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.calls()).toBe(2);
		expect(model.seen.filter(isCheck)).toHaveLength(0);
		expect(result.content).toBe("Outline written. Do you want the deck in Marp or reveal.js?");
	});
});

// ── Claim check (Rishi pilot l2-solo-deck runs 2026-09-29_142559 and _125252) ─
//
// Run 142559 (on #3014): the completion check fired and the model answered
// "DONE. All requested steps are complete and backed by tool results", listing
// "`ls deck` -> deck.md, outline.md". Its only `ls deck` was chained with && and
// BLOCKED; it used list_files instead. Run 125252: write_file deck/outline.md
// was blocked by TOOLG8, then the model said "Good, the outline was written."

const PILOT_PROMPT =
	"Research this repo's packages/decide folder, then write deck/outline.md with 5 slides about Eight System One, then turn that outline into deck/deck.md in Marp style with --- between slides, then run ls deck and wc -l deck/deck.md, then summarise what you did.";
const PILOT_WORK = "/pilot/l2-solo-deck/work";

/** The pilot's real executor behaviour: && chains are blocked, TOOLG8 can block a write. */
function pilotWorkspace(opts: { blockWrites?: Set<string> } = {}) {
	const files = new Map<string, string>([["packages/decide/README.md", "# @8gent/decide - Eight System One"]]);
	const commands: string[] = [];
	const rel = (p: string) => p.replace(`${PILOT_WORK}/`, "");
	const tools: TextTool[] = [
		{
			spec: { name: "read_file", description: "Read a file", parameters: {} },
			run: async (a) => files.get(rel(String(a.path))) ?? `Error: no such file ${a.path}`,
		},
		{
			spec: { name: "list_files", description: "List files", parameters: {} },
			run: async (a) => {
				const dir = `${rel(String(a.path)).replace(/\/$/, "")}/`;
				return [...files.keys()].filter((p) => p.startsWith(dir)).map((p) => p.slice(dir.length)).join("\n");
			},
		},
		{
			spec: { name: "write_file", description: "Write a file", parameters: {} },
			run: async (a) => {
				const p = rel(String(a.path));
				if (opts.blockWrites?.has(p)) {
					return `[TOOLG8 BLOCKED] write_file did NOT run. Reason: [no-secrets-in-files] Cannot write secrets or credentials to files.`;
				}
				files.set(p, String(a.content));
				return `File written and opened: ${PILOT_WORK}/${p}`;
			},
		},
		{
			spec: { name: "run_command", description: "Run a command", parameters: {} },
			run: async (a) => {
				const cmd = String(a.command);
				commands.push(cmd);
				if (cmd.includes("&&")) {
					return `[BLOCKED] Command chaining with && is not allowed. Use separate run_command calls instead. Command: ${cmd}`;
				}
				if (cmd.startsWith("mkdir")) return "Command completed successfully.";
				if (cmd === "ls deck") {
					return [...files.keys()].filter((p) => p.startsWith("deck/")).map((p) => p.slice(5)).join("\n");
				}
				const wc = /^wc -l (.+)$/.exec(cmd);
				if (wc) {
					const f = files.get(rel(wc[1]));
					return f === undefined ? `Exit code 1:\n\nwc: ${wc[1]}: No such file` : `      ${f.split("\n").length} ${wc[1]}\n`;
				}
				return "Command completed successfully.";
			},
		},
	];
	return { files, commands, tools };
}

const RUN9_TOOL_ROUNDS = [
	tc("list_files", { path: "packages/decide" }),
	tc("read_file", { path: "packages/decide/README.md" }),
	tc("write_file", { path: "deck/outline.md", content: "# Outline\n1. What" }),
	tc("write_file", { path: "deck/deck.md", content: "---\nmarp: true\n---\n# What" }),
	tc("run_command", { command: `cd ${PILOT_WORK} && ls deck && echo '---' && wc -l deck/deck.md` }),
	tc("list_files", { path: `${PILOT_WORK}/deck` }),
	tc("run_command", { command: `wc -l ${PILOT_WORK}/deck/deck.md` }),
];
const RUN9_DONE =
	"DONE. All requested steps are complete and backed by tool results:\n\n2. **Wrote `deck/outline.md`** with 5 slides.\n\n3. **Wrote `deck/deck.md`** in Marp style.\n\n4. **Verified on disk**:\n   - `ls deck` → `deck.md`, `outline.md`\n   - `wc -l deck/deck.md` → **5 lines**";

const isClaimFollowUp = (msgs: TextToolMessage[]) =>
	lastUserMessage(msgs).startsWith("Your final answer does not match the tool log:");

describe("runTextToolAgent - claim check", () => {
	test("run 142559 replay: a DONE that lists a blocked `ls deck` gets one follow-up, and the model runs it", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([
			...RUN9_TOOL_ROUNDS,
			RUN9_DONE, // first no-tool reply: the #3014 completion check fires
			RUN9_DONE, // its answer to the check: the claim check fires
			tc("run_command", { command: "ls deck" }),
			"DONE: Ran ls deck (deck.md, outline.md). Everything else as summarised.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		const followUps = model.seen.filter(isClaimFollowUp);
		expect(followUps).toHaveLength(1);
		const text = lastUserMessage(followUps[0]);
		expect(text).toContain("Your summary says `ls deck` ran");
		expect(text).toContain("[BLOCKED] Command chaining");
		expect(text).not.toContain("wc -l");
		expect(ws.commands.at(-1)).toBe("ls deck");
		expect(result.unverified).toEqual([]);
		expect(result.content).toBe("Ran ls deck (deck.md, outline.md). Everything else as summarised.");
		expect(result.content).not.toContain("[harness]");
		expect(result.rounds).toBe(RUN9_TOOL_ROUNDS.length + 4);
	});

	test("run 142559 replay: if the model repeats its false DONE, the user sees a harness note", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([...RUN9_TOOL_ROUNDS, RUN9_DONE]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// Tool rounds + completion check + one claim follow-up; never more.
		expect(model.calls()).toBe(RUN9_TOOL_ROUNDS.length + 3);
		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(1);
		expect(result.unverified).toEqual(["'ls deck' was requested but never ran (its only attempt was blocked)"]);
		expect(result.content.endsWith("\n\n[harness] Not verified: 'ls deck' was requested but never ran (its only attempt was blocked).")).toBe(true);
		expect(result.content.startsWith("DONE. All requested steps")).toBe(true);
	});

	test("run 125252 replay: a blocked outline write reported as written is followed up, and fixed", async () => {
		const blocked = new Set(["deck/outline.md"]);
		const ws = pilotWorkspace({ blockWrites: blocked });
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			tc("run_command", { command: "mkdir -p deck" }),
			"Good, the outline was written. Now let me write the Marp deck:",
			"DONE: Good, the outline was written.",
			(msgs) => {
				// The follow-up names the blocked write; the gate is lifted (e.g. the
				// model removed the offending content) and it tries again.
				expect(lastUserMessage(msgs)).toContain("deck/outline.md was written, but the tool log shows it was not");
				expect(lastUserMessage(msgs)).toContain("[TOOLG8 BLOCKED]");
				blocked.clear();
				return tc("write_file", { path: "deck/outline.md", content: "1. What" });
			},
			tc("write_file", { path: "deck/deck.md", content: "# What" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"Wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l deck/deck.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(1);
		expect(ws.files.has("deck/outline.md")).toBe(true);
		expect(result.unverified).toEqual([]);
		expect(result.content).toBe("Wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l deck/deck.md.");
	});

	test("run 125252 replay: a model that never acts leaves every contradiction in the note", async () => {
		const ws = pilotWorkspace({ blockWrites: new Set(["deck/outline.md"]) });
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			tc("run_command", { command: "mkdir -p deck" }),
			"Good, the outline was written. Now let me write the Marp deck:",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(model.calls()).toBe(6);
		expect(result.unverified).toEqual([
			"'ls deck' was requested but never ran",
			"'wc -l deck/deck.md' was requested but never ran",
			"'deck/outline.md' was reported written but its last write was blocked",
		]);
		expect(result.content).toContain("[harness] Not verified: 'deck/outline.md' was reported written but its last write was blocked.");
	});

	test("a truthful DONE gets no claim follow-up and no note", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			tc("write_file", { path: "deck/deck.md", content: "# What" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"DONE: Wrote deck/outline.md and deck/deck.md; `ls deck` shows both; `wc -l deck/deck.md` is 1 line.",
			"DONE: Wrote deck/outline.md and deck/deck.md; `ls deck` shows both; `wc -l deck/deck.md` is 1 line.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// The DONE-prefixed first reply still gets #3014's one completion check;
		// the script answers it with the same DONE. No claim follow-up.
		expect(model.calls()).toBe(7);
		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(0);
		expect(result.unverified).toEqual([]);
		expect(result.content).not.toContain("[harness]");
	});

	test("rounds exhausted: no follow-up can be sent, the note is appended instead", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([...RUN9_TOOL_ROUNDS, RUN9_DONE]);
		// Tool rounds + the completion check round leaves no round for a follow-up.
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: RUN9_TOOL_ROUNDS.length + 2,
		});
		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(0);
		expect(result.rounds).toBe(RUN9_TOOL_ROUNDS.length + 2);
		expect(result.unverified).toHaveLength(1);
		expect(result.content).toContain("[harness] Not verified: 'ls deck' was requested but never ran");
	});

	test("rounds exhausted while still calling tools: the last prose is annotated too", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([tc("read_file", { path: "packages/decide/README.md" })]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "run `ls deck`" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 3,
		});
		expect(model.calls()).toBe(3);
		expect(result.unverified).toEqual(["'ls deck' was requested but never ran"]);
		expect(result.content).toBe("[harness] Not verified: 'ls deck' was requested but never ran.");
	});

	test("no loop: a model that answers every follow-up with more false prose gets exactly one", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([tc("read_file", { path: "packages/decide/README.md" }), "DONE: ran ls deck."]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read the README then run ls deck" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		// tool round, completion check, one claim follow-up, then the turn ends.
		expect(model.calls()).toBe(4);
		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(1);
		expect(result.unverified).toEqual(["'ls deck' was requested but never ran"]);
	});

	test("no tool use at all: nothing is checked (the agent-level honesty gate owns that case)", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel(["I ran ls deck and wrote deck/outline.md.", "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: PILOT_PROMPT }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(1);
		expect(result.unverified).toEqual([]);
		expect(result.content).toBe("I ran ls deck and wrote deck/outline.md.");
	});

	test("claims about files outside the request are not over-policed", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			tc("run_command", { command: "bun run build" }),
			"DONE: Wrote deck/outline.md, and the build generated dist/index.js. I read `README.md` and `index.ts` first.",
			"DONE: Wrote deck/outline.md, and the build generated dist/index.js. I read `README.md` and `index.ts` first.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read packages/decide/README.md and write deck/outline.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.seen.filter(isClaimFollowUp)).toHaveLength(0);
		expect(result.unverified).toEqual([]);
	});

	test("a question to the user gets no follow-up, but an unrun requested command is still noted", async () => {
		const ws = pilotWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			"Outline written. Should I run ls deck now?",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write deck/outline.md then run ls deck" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(2);
		expect(result.unverified).toEqual(["'ls deck' was requested but never ran"]);
		expect(result.content).toStartWith("Outline written. Should I run ls deck now?\n\n[harness]");
	});
});
