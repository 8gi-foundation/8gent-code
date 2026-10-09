import { describe, expect, test } from "bun:test";
import {
	cleanDegenerateReply,
	COMPLETION_CHECK_MESSAGE,
	DEGENERATE_REPEAT_MIN,
	DEGENERATE_REPLY_MESSAGE,
	DONE_MARKER,
	hasDoneMarker,
	isQuestionToUser,
	MAX_COMPLETION_CHECKS,
	MAX_CONSECUTIVE_CHECKS,
	MAX_CALLS_PER_ROUND,
	abortedCallResult,
	blockedCheckMessage,
	blockedStopNote,
	blockReason,
	emptyReplyNote,
	emptyReplyStall,
	overCapCallResult,
	unknownToolResult,
	isShellFileWrite,
	runTextToolAgent,
	stripDoneMarker,
	openPlanSteps,
	planCheckMessage,
	IMAGE_ATTACHMENT_MARKER,
	imageAttachmentResult,
	splitImageAttachment,
	type TextTool,
} from "./text-tool-loop";
import type { TextToolMessage } from "./text-tool-client";
import { LLAMA32_BARE_JSON_REPLY } from "./text-tools.fixtures";

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
			return "DONE: The secret number is 4242.";
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
			return "DONE: Wrote the outline.";
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
			"DONE: Researched the package, wrote deck/outline.md and deck/deck.md (3 lines).",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(ws.files.has("deck/deck.md")).toBe(true);
		expect(ws.commands).toEqual(["ls deck", "wc -l deck/deck.md"]);
		expect(result.content).toStartWith("Researched the package");
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

	test("does not loop forever: a model that keeps announcing is checked up to the cap, then the turn ends", async () => {
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

		// MAX_CONSECUTIVE_CHECKS checks, then one claim follow-up (ls deck and wc
		// never ran), then the turn ends with both contradictions noted.
		expect(model.seen.filter((m) => lastUserMessage(m) === COMPLETION_CHECK_MESSAGE)).toHaveLength(
			MAX_CONSECUTIVE_CHECKS,
		);
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS + 1);
		expect(result.rounds).toBe(2 + MAX_CONSECUTIVE_CHECKS + 1);
		expect(result.content).toBe(
			"Now let me write the deck:\n\n[harness] Not verified: 'ls deck' was requested but never ran.\n[harness] Not verified: 'wc -l deck/deck.md' was requested but never ran.",
		);
		expect(result.unverified).toHaveLength(2);
		expect(ws.files.has("deck/deck.md")).toBe(false);
	});

	test("re-armed: a stall after the model resumes work is checked again, and DONE then ends it", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Next, the deck:",
			tc("write_file", { path: "deck/deck.md", content: "y" }),
			"Now I will run the checks:",
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"DONE: Ran ls deck and wc -l deck/deck.md.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// One check after "Next, the deck:", a second after "Now I will run the
		// checks:"; the DONE-marked reply after the last tool round is final.
		expect(model.seen.filter((m) => lastUserMessage(m) === COMPLETION_CHECK_MESSAGE)).toHaveLength(2);
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

	test("prose after a round whose every tool call failed gets the completion check", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "missing.md" }),
			"Let me try another way:",
			tc("read_file", { path: "packages/decide/README.md" }),
			"DONE: Read packages/decide/README.md instead.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read it" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		// A failed (not blocked) round gets the plain check.
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(model.calls()).toBe(4);
		expect(result.content).toBe("Read packages/decide/README.md instead.");
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
			"DONE: It is called Eight System One.",
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
			"DONE: Researched the package, wrote deck/outline.md and deck/deck.md, listed deck, counted 3 lines.",
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

	test("no infinite loop: a model that keeps announcing with a period is checked up to the cap, then the turn ends", async () => {
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

		// MAX_CONSECUTIVE_CHECKS checks, one claim follow-up, then the turn ends noted.
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS + 1);
		expect(result.rounds).toBe(2 + MAX_CONSECUTIVE_CHECKS + 1);
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_CONSECUTIVE_CHECKS);
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

// ── Re-check until DONE (Rishi pilot l2-solo-deck run 2026-09-29_225823) ─────
//
// qwen3.8 27B researched, wrote deck/outline.md, then replied with prose. The
// one-per-turn check fired, and the model answered it with more prose and no
// tool call: "I still need to write `deck/deck.md` and then run the
// verification commands. Doing that now." That became the final answer, and
// deck.md, ls deck and wc -l never happened.

const RUN_225823_STALL =
	"I still need to write `deck/deck.md` and then run the verification commands. Doing that now.";

describe("runTextToolAgent - re-check until DONE", () => {
	test("run 225823 replay: prose, check, 'Doing that now.', check again, then tools, and the task finishes", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			tc("write_file", { path: "deck/outline.md", content: "1. What\n2. Why" }),
			"The outline is written. Next I will build the Marp deck.",
			RUN_225823_STALL,
			tc("write_file", { path: "deck/deck.md", content: "# What\n---\n# Why" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"DONE: Researched the package, wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		expect(isCheck(model.seen[3])).toBe(true);
		expect(isCheck(model.seen[4])).toBe(true);
		expect(model.seen[4][model.seen[4].length - 2]).toEqual({ role: "assistant", content: RUN_225823_STALL });
		expect(model.seen.filter(isCheck)).toHaveLength(2);
		expect(ws.files.get("deck/deck.md")).toBe("# What\n---\n# Why");
		expect(ws.commands).toEqual(["ls deck", "wc -l deck/deck.md"]);
		expect(model.calls()).toBe(8);
		expect(result.rounds).toBe(8);
		expect(result.content).toBe("Researched the package, wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l.");
		expect(result.unverified).toEqual([]);
	});

	test("a real finish: 'DONE: summary' ends the turn after one check", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Wrote deck/outline.md.",
			"DONE: Wrote deck/outline.md with the outline.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write deck/outline.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(3);
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Wrote deck/outline.md with the outline.");
	});

	test("the same finish with keepAnswerFirst: the reply before the check comes first, then the summary (#3638)", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Wrote deck/outline.md.",
			"DONE: Wrote deck/outline.md with the outline.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write deck/outline.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
			keepAnswerFirst: true,
		});
		expect(model.calls()).toBe(3);
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Wrote deck/outline.md.\n\nWrote deck/outline.md with the outline.");
	});

	test("a model that never complies stops at the cap: no infinite loop", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([tc("write_file", { path: "deck/outline.md", content: "x" }), RUN_225823_STALL]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write deck/outline.md, then deck/deck.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		// Two checks in a row with no tool work between them, then the turn ends.
		expect(MAX_CONSECUTIVE_CHECKS).toBe(2);
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_CONSECUTIVE_CHECKS);
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS);
		expect(result.rounds).toBe(2 + MAX_CONSECUTIVE_CHECKS);
		expect(result.content).toBe(RUN_225823_STALL);
	});

	test("progress resets the cap: a stall after real tool work is checked again, past three checks", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "a.md", content: "a" }),
			"Next.",
			tc("write_file", { path: "b.md", content: "b" }),
			"Next.",
			tc("write_file", { path: "c.md", content: "c" }),
			"Next.",
			tc("write_file", { path: "d.md", content: "d" }),
			"Next.",
			tc("write_file", { path: "e.md", content: "e" }),
			"DONE: Wrote five files.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write five files" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(4);
		expect(model.calls()).toBe(10);
		expect(ws.files.get("e.md")).toBe("e");
		expect(result.content).toBe("Wrote five files.");
	});

	test("a never-complies model stops after two checks in a row, even after earlier progress", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "a.md", content: "a" }),
			"Next.",
			tc("write_file", { path: "b.md", content: "b" }),
			"Next.",
			"Doing that now.",
			"Doing that now.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write three files" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		// One check after the first stall; after b.md, two in a row, then it ends.
		expect(model.seen.filter(isCheck)).toHaveLength(1 + MAX_CONSECUTIVE_CHECKS);
		expect(model.calls()).toBe(6);
		expect(result.content).toBe("Doing that now.");
	});

	test("an erroring tool round is not progress: it does not reset the consecutive cap", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "a.md", content: "a" }),
			"Next.",
			tc("no_such_tool", {}),
			"Next.",
			"Next.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write two files" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		// Check 1 after the first "Next."; the all-failed round makes the next
		// "Next." a stall (check 2), but the erroring call is not progress, so the
		// consecutive count is not reset and the third "Next." ends the turn.
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_CONSECUTIVE_CHECKS);
		expect(model.calls()).toBe(5);
		expect(result.content).toBe("Next.");
	});

	test("the per-turn ceiling still bounds a model that alternates work and stalls forever", async () => {
		const ws = fakeWorkspace();
		let n = 0;
		const model = scriptedModel([
			() => {
				n++;
				return n % 2 === 1 ? tc("write_file", { path: `f${n}.md`, content: "x" }) : "Next.";
			},
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write files until told to stop" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 500,
		});
		expect(MAX_COMPLETION_CHECKS).toBe(10);
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_COMPLETION_CHECKS);
		// Ten work/stall/check cycles, then one more work round and a final stall.
		expect(model.calls()).toBe(2 * MAX_COMPLETION_CHECKS + 2);
		expect(result.content).toBe("Next.");
	});

	test("a question to the user after a check ends the turn at once", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			"Outline written.",
			"Should the deck use Marp or reveal.js?",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "make a deck" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(3);
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Should the deck use Marp or reveal.js?");
	});

	test("the check message still asks for DONE: plus a summary when finished", () => {
		expect(COMPLETION_CHECK_MESSAGE).toContain(`start it with "${DONE_MARKER}"`);
		expect(COMPLETION_CHECK_MESSAGE).toContain("final summary");
	});
});

describe("hasDoneMarker", () => {
	test("a leading DONE: or DONE. (plain or bold) is the marker", () => {
		expect(hasDoneMarker("DONE: wrote it")).toBe(true);
		expect(hasDoneMarker("  **DONE:** wrote it")).toBe(true);
		expect(hasDoneMarker("DONE. All requested steps are complete")).toBe(true);
	});
	test("anything else is not", () => {
		expect(hasDoneMarker("Done, mostly")).toBe(false);
		expect(hasDoneMarker(RUN_225823_STALL)).toBe(false);
		expect(hasDoneMarker("I am DONE: really")).toBe(false);
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
			"DONE: Wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l deck/deck.md.",
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

		// 3 tool rounds, the stall, MAX_CONSECUTIVE_CHECKS answers, one claim follow-up.
		expect(model.calls()).toBe(4 + MAX_CONSECUTIVE_CHECKS + 1);
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
		// The last round was tool calls only, so there is no answer at all (#3091).
		expect(result.unverified).toEqual([emptyReplyStall(3), "'ls deck' was requested but never ran"]);
		expect(result.content).toBe(
			`${emptyReplyNote(3)}\n\n[harness] Not verified: 'ls deck' was requested but never ran.`,
		);
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

describe("runTextToolAgent - bare JSON calls (llama3.2:3b, rishi-pilot l2-split-deck)", () => {
	test("runs both bare calls from the recorded reply, in order", async () => {
		const ran: string[] = [];
		const tool = (name: string): TextTool => ({
			spec: { name, description: name, parameters: { type: "object", properties: {} } },
			run: async () => {
				ran.push(name);
				return `${name} ok`;
			},
		});
		let turn = 0;
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Turn deck/outline.md into deck/deck.md" }],
			tools: [tool("get_outline"), tool("write_file")],
			call: async () =>
				++turn === 1 ? LLAMA32_BARE_JSON_REPLY : `${DONE_MARKER} wrote deck/deck.md`,
		});
		expect(ran).toEqual(["get_outline", "write_file"]);
		expect(result.toolLog.map((e) => e.name)).toEqual(["get_outline", "write_file"]);
	});

	test("a JSON example naming an unregistered tool ends the turn as prose", async () => {
		const answer = [
			"Example body:",
			"```json",
			'{"name": "create_user", "arguments": {}}',
			"```",
		].join("\n");
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "show me an example" }],
			tools: [READ_FILE_TOOL],
			call: async () => answer,
		});
		expect(result.toolLog).toEqual([]);
		expect(result.content).toBe(answer);
	});
});

// ── Progress resets the check cap (Rishi pilot l4-deck-plus-m5 run 2026-09-30_005300) ──
//
// qwen3.8 27B on a six-part deck task explored for 13 rounds. Three times it
// replied with prose and no tool call straight after a successful tool round;
// each got a completion check and each time the model resumed real tool work.
// The fourth such reply, "The root has no README.md yet and no `deck/` folder.
// Let me check git status, then start building.", found the per-turn cap of 3
// spent, became the final answer, and no file was ever written.

const RUN_005300_FINAL_STALL =
	"The root has no README.md yet and no `deck/` folder. Let me check git status, then start building.";

describe("runTextToolAgent - progress resets the check cap", () => {
	test("run 005300 replay: four announce/check/resume cycles, and the fourth announcement is checked, not final", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"I have what I need from the package. Let me check the tools available.",
			tc("run_command", { command: "which ffmpeg ffprobe git" }),
			"ffmpeg is there. Let me look at the root.",
			tc("run_command", { command: "pwd" }),
			"Now let me see what is in the root.",
			tc("run_command", { command: "ls -la" }),
			RUN_005300_FINAL_STALL,
			// The fourth check lands; the model builds.
			tc("write_file", { path: "deck/outline.md", content: "1. What\n2. Why" }),
			tc("write_file", { path: "deck/deck.md", content: "# What\n---\n# Why" }),
			tc("run_command", { command: "ls deck" }),
			tc("run_command", { command: "wc -l deck/deck.md" }),
			"DONE: Researched the package, wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: FIVE_STEP_TASK }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// Past the old per-turn cap of 3: every stall followed real tool work.
		expect(model.seen.filter(isCheck)).toHaveLength(4);
		expect(model.seen[8][model.seen[8].length - 2]).toEqual({
			role: "assistant",
			content: RUN_005300_FINAL_STALL,
		});
		expect(isCheck(model.seen[8])).toBe(true);
		expect(ws.files.get("deck/outline.md")).toBe("1. What\n2. Why");
		expect(ws.files.get("deck/deck.md")).toBe("# What\n---\n# Why");
		expect(ws.commands).toEqual(["which ffmpeg ffprobe git", "pwd", "ls -la", "ls deck", "wc -l deck/deck.md"]);
		expect(model.calls()).toBe(13);
		expect(result.rounds).toBe(13);
		expect(result.content).toBe(
			"Researched the package, wrote deck/outline.md and deck/deck.md, ran ls deck and wc -l.",
		);
		expect(result.unverified).toEqual([]);
	});

	test("run 005300 shape with a model that then never complies: two checks in a row, then the turn ends", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("read_file", { path: "packages/decide/README.md" }),
			"Let me check the tools available.",
			tc("run_command", { command: "pwd" }),
			"Now let me see what is in the root.",
			tc("run_command", { command: "ls -la" }),
			RUN_005300_FINAL_STALL,
			"Starting now.",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Research packages/decide, then write deck/outline.md." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// One check each for the first two stalls (each resumed with tools), then
		// the final stall gets two checks in a row and the turn ends.
		expect(model.seen.filter(isCheck)).toHaveLength(2 + MAX_CONSECUTIVE_CHECKS);
		expect(model.calls()).toBe(6 + MAX_CONSECUTIVE_CHECKS);
		expect(result.content).toBe("Starting now.");
		expect(ws.files.has("deck/outline.md")).toBe(false);
	});
});

// ── Repetition degeneration (Rishi pilot l4-refactor-m5 run 2026-09-30_010512) ──
//
// The refactor itself succeeded (tests pass, hidden judge passes). qwen3.8 27B
// then replied "Let me capture output inside the working directory and read
// it." followed by 144 "[TOOL_CALL]" lines, each in front of the same
// read_file call. The circuit breaker aborted the turn (103 calls, limit 50),
// and the abort exit returned that reply as it was: the user got 144
// "[TOOL_CALL]" lines and no summary.

const RUN_010512_PROSE = "Let me capture output inside the working directory and read it.";

function run010512Reply(n: number, withCalls: boolean): string {
	const unit = withCalls
		? `[TOOL_CALL]\n${tc("read_file", { path: "./buntest.out" })}\n`
		: "[TOOL_CALL]\n\n\n";
	return `${RUN_010512_PROSE}\n\n${unit.repeat(n)}`;
}

describe("cleanDegenerateReply", () => {
	test("strips placeholder lines and flags a mostly-junk reply", () => {
		const raw = `${RUN_010512_PROSE}\n\n${"[TOOL_CALL]\n\n\n".repeat(144)}`;
		const r = cleanDegenerateReply(raw);
		expect(r.degenerate).toBe(true);
		expect(r.clean).toBe(RUN_010512_PROSE);
	});

	test("a run of DEGENERATE_REPEAT_MIN identical lines keeps one copy", () => {
		const raw = ["Summary.", ...Array(DEGENERATE_REPEAT_MIN).fill("I will read the file now.")].join("\n");
		const r = cleanDegenerateReply(raw);
		expect(r.degenerate).toBe(true);
		expect(r.clean).toBe("Summary.\nI will read the file now.");
	});

	test("angle-tag placeholders are stripped too; a lone one is not degenerate", () => {
		expect(cleanDegenerateReply("Done the rename.\n<tool_call>\n</tool_call>")).toEqual({
			clean: "Done the rename.",
			degenerate: false,
		});
		expect(cleanDegenerateReply("[TOOL_CALL]")).toEqual({ clean: "", degenerate: true });
	});

	test("a table with repeated values is not flagged or changed", () => {
		const rows = Array.from({ length: 12 }, (_, i) => `| src/file${i}.ts | 0 | pass |`);
		const same = Array(12).fill("| - | 0 | pass |");
		const table = ["| file | fail | status |", "|---|---|---|", ...rows, ...same].join("\n");
		expect(cleanDegenerateReply(table)).toEqual({ clean: table, degenerate: false });
	});

	test("ordinary prose, short repeats, and repeated words in a line are untouched", () => {
		const text = [
			"DONE: Renamed formatPrice to formatMoney.",
			"- ok",
			"- ok",
			"- ok",
			"Tests: pass pass pass pass pass pass pass pass pass pass.",
		].join("\n");
		expect(cleanDegenerateReply(text)).toEqual({ clean: text, degenerate: false });
	});
});

describe("runTextToolAgent - repetition degeneration", () => {
	test("run 010512 replay: circuit-breaker abort after a '[TOOL_CALL]' x144 reply returns only the prose", async () => {
		const ws = fakeWorkspace();
		ws.files.set("./buntest.out", "3 pass 0 fail");
		const ac = new AbortController();
		let calls = 0;
		// Mirror agent.ts: the circuit breaker aborts the shared signal from
		// inside a tool once the turn's tool-call limit is passed.
		const tools = ws.tools.map((t) => ({
			...t,
			run: async (a: Record<string, unknown>) => {
				// 10, not the real 50: the round cap (MAX_CALLS_PER_ROUND) now stops
				// a single reply well before 50, so the abort must land inside it.
				if (++calls > 10) ac.abort();
				return t.run(a);
			},
		}));
		const model = scriptedModel([
			tc("run_command", { command: "bun test > ./buntest.out 2>&1" }),
			run010512Reply(144, true),
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Rename formatPrice to formatMoney and run bun test." }],
			tools,
			call: model.call,
			maxRounds: 50,
			signal: ac.signal,
		});

		expect(model.calls()).toBe(2);
		expect(result.toolLog).toHaveLength(145);
		expect(result.content).not.toContain("[TOOL_CALL]");
		expect(result.content).toStartWith(RUN_010512_PROSE);
	});

	test("the junk never goes back to the model as its own history", async () => {
		const ws = fakeWorkspace();
		ws.files.set("./buntest.out", "3 pass 0 fail");
		const model = scriptedModel([
			run010512Reply(20, true),
			// A DONE reply straight after a tool round still gets the one check.
			"DONE: Renamed it; bun test shows 3 pass, 0 fail.",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read ./buntest.out" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		const history = model.seen[1].filter((m) => m.role === "assistant").map((m) => m.content);
		expect(history).toEqual([RUN_010512_PROSE]);
		expect(result.content).toBe("Renamed it; bun test shows 3 pass, 0 fail.");
	});

	test("a no-tool-call degenerate reply is treated as a stall: corrective message, then DONE ends it", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "src/format.ts", content: "export function formatMoney() {}" }),
			run010512Reply(144, false),
			"DONE: Renamed formatPrice to formatMoney in src/format.ts.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Rename formatPrice to formatMoney." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(lastUserMessage(model.seen[2])).toBe(DEGENERATE_REPLY_MESSAGE);
		expect(model.seen[2][model.seen[2].length - 2]).toEqual({ role: "assistant", content: RUN_010512_PROSE });
		expect(model.calls()).toBe(3);
		expect(result.content).toBe("Renamed formatPrice to formatMoney in src/format.ts.");
	});

	test("still degenerate at the cap: only the non-junk prose is returned, and the loop is bounded", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "src/format.ts", content: "x" }),
			run010512Reply(144, false),
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Rename formatPrice to formatMoney." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.seen.filter((m) => lastUserMessage(m) === DEGENERATE_REPLY_MESSAGE)).toHaveLength(
			MAX_CONSECUTIVE_CHECKS,
		);
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS);
		expect(result.content).toBe(RUN_010512_PROSE);
	});

	test("a legitimately repetitive final answer (a table) ends the turn as normal", async () => {
		const ws = fakeWorkspace();
		const table = [
			"DONE: Results:",
			"| file | fail | status |",
			"|---|---|---|",
			...Array(10).fill("| src/cart.ts | 0 | pass |"),
		].join("\n");
		// The table answers the usual completion check, too.
		const model = scriptedModel([tc("write_file", { path: "a.md", content: "a" }), table]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write a.md" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.seen.filter((m) => lastUserMessage(m) === DEGENERATE_REPLY_MESSAGE)).toHaveLength(0);
		expect(model.calls()).toBe(3);
		expect(result.content).toBe(table.replace(/^DONE: /, ""));
	});
});

// ── Abort mid-round and the per-reply call cap (issue #3056, run 2026-09-30_010512) ──
//
// qwen3.8 27B asked for 144 read_file calls in one reply. The circuit breaker
// aborted the turn at 103 calls, but the loop only checked the signal at the
// top of a round, so it ran all 144 anyway.

function countingReadTool(onRun?: (n: number) => void) {
	let runs = 0;
	const tool: TextTool = {
		...READ_FILE_TOOL,
		run: async () => {
			runs++;
			onRun?.(runs);
			return "contents";
		},
	};
	return { tool, runs: () => runs };
}

function manyReads(n: number): string {
	return Array.from({ length: n }, (_, i) => tc("read_file", { path: `f${i}.ts` })).join("\n");
}

describe("runTextToolAgent - abort mid-round", () => {
	test("a round of 144 calls with an abort after N runs only N, and the turn ends", async () => {
		const N = 7;
		const ac = new AbortController();
		const { tool, runs } = countingReadTool((n) => {
			if (n === N) ac.abort();
		});
		const model = scriptedModel([manyReads(144), "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read everything" }],
			tools: [tool],
			call: model.call,
			maxRounds: 10,
			signal: ac.signal,
		});
		expect(runs()).toBe(N);
		expect(model.calls()).toBe(1);
		expect(result.rounds).toBe(1);
		expect(result.content).not.toContain("UNREACHED");
	});

	test("every skipped call is in the tool log as not run, never as done", async () => {
		const N = 7;
		const ac = new AbortController();
		const { tool } = countingReadTool((n) => {
			if (n === N) ac.abort();
		});
		const model = scriptedModel([manyReads(20)]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read everything" }],
			tools: [tool],
			call: model.call,
			signal: ac.signal,
		});
		expect(result.toolLog).toHaveLength(20);
		expect(result.toolLog.slice(0, N).every((e) => e.result === "contents")).toBe(true);
		const skipped = result.toolLog.slice(N);
		expect(skipped).toHaveLength(20 - N);
		expect(skipped.every((e) => e.result === "Error: not run: turn aborted.")).toBe(true);
		expect(skipped[0].args).toEqual({ path: `f${N}.ts` });
	});

	test("an abort reason, when given, is recorded with the skipped calls", async () => {
		const ac = new AbortController();
		const reason = "Global tool call limit exceeded: 103 calls this turn (limit: 50)";
		const { tool } = countingReadTool((n) => {
			if (n === 2) ac.abort(new Error(reason));
		});
		const model = scriptedModel([manyReads(4)]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read everything" }],
			tools: [tool],
			call: model.call,
			signal: ac.signal,
		});
		expect(result.toolLog[3].result).toBe(`Error: not run: turn aborted (${reason}).`);
		expect(abortedCallResult(undefined)).toBe("Error: not run: turn aborted.");
	});

	test("a skipped run_command the user asked for is reported as not verified", async () => {
		const ac = new AbortController();
		const ws = fakeWorkspace();
		const tools = ws.tools.map((t) =>
			t.spec.name === "read_file"
				? { ...t, run: async (a: Record<string, unknown>) => { ac.abort(); return t.run(a); } }
				: t,
		);
		const model = scriptedModel([
			[tc("read_file", { path: "packages/decide/README.md" }), tc("run_command", { command: "bun test" })].join("\n"),
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Read the README, then run `bun test`." }],
			tools,
			call: model.call,
			signal: ac.signal,
		});
		expect(ws.commands).toEqual([]);
		expect(result.toolLog[1]).toEqual({
			name: "run_command",
			args: { command: "bun test" },
			result: "Error: not run: turn aborted.",
		});
		expect(result.unverified.some((u) => u.includes("bun test"))).toBe(true);
	});
});

describe("runTextToolAgent - per-reply call cap", () => {
	test("a reply with 144 calls runs only MAX_CALLS_PER_ROUND; the rest are logged and reported once", async () => {
		const { tool, runs } = countingReadTool();
		const model = scriptedModel([manyReads(144), "DONE: read them."]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read everything" }],
			tools: [tool],
			call: model.call,
			maxRounds: 10,
		});
		expect(MAX_CALLS_PER_ROUND).toBe(25);
		expect(runs()).toBe(MAX_CALLS_PER_ROUND);
		expect(result.toolLog).toHaveLength(144);
		const skipped = result.toolLog.slice(MAX_CALLS_PER_ROUND);
		expect(skipped.every((e) => e.result === overCapCallResult(144))).toBe(true);
		const fed = lastUserMessage(model.seen[1]);
		expect(fed.split("Tool read_file returned:").length - 1).toBe(MAX_CALLS_PER_ROUND);
		expect(fed.split("not run: too many tool calls").length - 1).toBe(1);
		expect(fed).toContain("Calls 26-144 (119) were not run");
	});

	test("normal rounds are unchanged: exactly MAX_CALLS_PER_ROUND calls all run, no extra text", async () => {
		const { tool, runs } = countingReadTool();
		const model = scriptedModel([manyReads(MAX_CALLS_PER_ROUND), "DONE: read them."]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "read everything" }],
			tools: [tool],
			call: model.call,
		});
		expect(runs()).toBe(MAX_CALLS_PER_ROUND);
		expect(result.toolLog.every((e) => e.result === "contents")).toBe(true);
		expect(lastUserMessage(model.seen[1])).not.toContain("not run");
	});
});

// ── Blocked tool rounds (Rishi pilot l4-deck-plus-m5 run 2026-09-30_014230) ──
//
// qwen3.8 27B had two run_command calls refused in a row: the toolg8 path
// guard blocked a command touching /dev/null, and the shell sanitizer blocked
// semicolon chaining. Blocked results do not start with "Error", so the loop
// counted them as successful work; the model then replied "Let me check
// tooling and the root README." and the turn ended with status ok, no files
// written, and nothing saying the calls had been refused.

const RUN_014230_DEVNULL_CMD =
	'cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null; pwd; head -50 README.md 2>/dev/null';
const RUN_014230_CHAIN_CMD = 'which ffmpeg ffprobe marp 2>&1; echo "---"; ffmpeg -version 2>&1 | head -n 3';
const RUN_014230_DEVNULL_RESULT =
	"[TOOLG8 BLOCKED] run_command did NOT run. Nothing was changed. Reason: [bash-segment] [path-guard] device file: /dev/null Alternative: Try a read-only command (git status, ls, cat) or request approval.";
const RUN_014230_CHAIN_RESULT = `[BLOCKED] Semicolon command chaining is not allowed. Use separate run_command calls instead. Command: ${RUN_014230_CHAIN_CMD}`;
const RUN_014230_STALL = "Let me check tooling and the root README.";
const DEVNULL_REASON = "[bash-segment] [path-guard] device file: /dev/null";
const CHAIN_REASON = "Semicolon command chaining is not allowed";

/** run_command that refuses the two command shapes the 014230 gates refused. */
function gatedWorkspace() {
	const commands: string[] = [];
	const tools: TextTool[] = [
		{
			spec: { name: "run_command", description: "Run a command", parameters: {} },
			run: async (a) => {
				const cmd = String(a.command);
				if (cmd.includes("/dev/null")) return RUN_014230_DEVNULL_RESULT;
				if (cmd.includes(";")) return `[BLOCKED] Semicolon command chaining is not allowed. Use separate run_command calls instead. Command: ${cmd}`;
				commands.push(cmd);
				return cmd === "which ffmpeg" ? "/opt/homebrew/bin/ffmpeg" : "ok";
			},
		},
	];
	return { tools, commands };
}

describe("blockReason", () => {
	test("reads the Reason field of a toolg8 block", () => {
		expect(blockReason(RUN_014230_DEVNULL_RESULT)).toBe(DEVNULL_REASON);
	});
	test("reads the first sentence of a sanitizer block, without the command", () => {
		expect(blockReason(RUN_014230_CHAIN_RESULT)).toBe(CHAIN_REASON);
	});
	test("is null for results that are not gate blocks", () => {
		expect(blockReason("Error: no such file")).toBeNull();
		expect(blockReason("Exit code 1: nope")).toBeNull();
		expect(blockReason("ok")).toBeNull();
	});
});

describe("runTextToolAgent - check after an all-blocked round", () => {
	test("run 014230 replay: two blocked calls, prose, a blocked check naming both reasons, then a working call and DONE", async () => {
		const ws = gatedWorkspace();
		const model = scriptedModel([
			[tc("run_command", { command: RUN_014230_DEVNULL_CMD }), tc("run_command", { command: RUN_014230_CHAIN_CMD })].join("\n"),
			RUN_014230_STALL,
			tc("run_command", { command: "which ffmpeg" }),
			"DONE: ffmpeg is at /opt/homebrew/bin/ffmpeg.",
			"UNREACHED",
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Check which video tools are installed." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});

		// Round 3 is answered with the tailored check, naming both reasons.
		const check = lastUserMessage(model.seen[2]);
		expect(check).toBe(blockedCheckMessage([DEVNULL_REASON, CHAIN_REASON]));
		expect(check).toContain("one command per run_command call, no chaining");
		expect(check).toContain(DONE_MARKER);
		expect(model.seen[2][model.seen[2].length - 2]).toEqual({ role: "assistant", content: RUN_014230_STALL });
		expect(ws.commands).toEqual(["which ffmpeg"]);
		expect(model.calls()).toBe(4);
		expect(result.rounds).toBe(4);
		expect(result.content).toBe("ffmpeg is at /opt/homebrew/bin/ffmpeg.");
		expect(result.content).not.toContain("[harness]");
		expect(result.unverified).toEqual([]);
	});

	test("an always-blocked model stops at the consecutive cap with a note naming the reasons", async () => {
		const ws = gatedWorkspace();
		let n = 0;
		const model = scriptedModel([
			() => {
				n++;
				// Alternate a blocked call and an announcement, forever.
				if (n % 2 === 0) return RUN_014230_STALL;
				return n % 4 === 1
					? tc("run_command", { command: RUN_014230_DEVNULL_CMD })
					: tc("run_command", { command: RUN_014230_CHAIN_CMD });
			},
		]);

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Check which video tools are installed." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 500,
		});

		// blocked, stall, check 1, blocked, stall, check 2, blocked, stall: end.
		// A blocked call is not progress, so it never resets the cap.
		expect(MAX_CONSECUTIVE_CHECKS).toBe(2);
		const checks = model.seen.map(lastUserMessage).filter((m) => m.startsWith("Your last tool calls were blocked"));
		expect(checks).toHaveLength(MAX_CONSECUTIVE_CHECKS);
		expect(model.calls()).toBe(2 * MAX_CONSECUTIVE_CHECKS + 2);
		expect(ws.commands).toEqual([]);
		expect(result.content).toBe(
			`${RUN_014230_STALL}\n\n${blockedStopNote([DEVNULL_REASON, CHAIN_REASON])}`,
		);
		expect(result.content).toContain(DEVNULL_REASON);
		expect(result.content).toContain(CHAIN_REASON);
	});

	test("a model that answers a blocked check with only prose is capped too, with the note", async () => {
		const ws = gatedWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: RUN_014230_CHAIN_CMD }),
			RUN_014230_STALL,
			"Checking now.",
			"Still checking.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Check which video tools are installed." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS);
		expect(result.content).toBe(`Still checking.\n\n${blockedStopNote([CHAIN_REASON])}`);
	});

	test("a question to the user after an all-blocked round ends the turn unchecked", async () => {
		const ws = gatedWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: RUN_014230_DEVNULL_CMD }),
			"The path guard blocks /dev/null. May I approve that command?",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Check the README." }],
			tools: ws.tools,
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("The path guard blocks /dev/null. May I approve that command?");
	});
});

// #3091: pilot run 2026-09-30_055542/l4-spawn-parallel-m5. After 8 read-only
// tool calls, qwen3.8 answered three times in a row with a call the harness
// never ran (structured spawn_agent, dropped as unregistered) and no text.
// The first two got completion checks; the third, with the check budget
// spent, was returned as the turn's answer: "" with status ok, and the TUI
// showed "No reply.". An empty reply after tool work is never a finished turn.
describe("runTextToolAgent - empty final reply after tool work (#3091)", () => {
	test("an empty reply after a tool round is checked, and a spent budget ends with a harness note, not an empty answer", async () => {
		const model = scriptedModel([tc("read_file", { path: "README.md" }), "", "", "", "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Fix both modules with sub-agents." }],
			tools: [READ_FILE_TOOL],
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(2 + MAX_CONSECUTIVE_CHECKS);
		expect(result.content.trim()).not.toBe("");
		expect(result.content).toBe(emptyReplyNote(1));
		expect(result.unverified).toEqual([emptyReplyStall(1)]);
	});

	test("an empty reply after a cut-off call is not accepted either: it gets the check", async () => {
		const model = scriptedModel([
			tc("read_file", { path: "README.md" }),
			'```tool_call\n{"name": "read_file", "arguments": {"path": "a.md", "limit',
			"",
			"DONE: Read the README.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Read the README." }],
			tools: [READ_FILE_TOOL],
			call: model.call,
			maxRounds: 50,
		});
		expect(model.calls()).toBe(4);
		expect(model.seen[3][model.seen[3].length - 1].content).toBe(COMPLETION_CHECK_MESSAGE);
		expect(result.content).toBe("Read the README.");
		expect(result.unverified).toEqual([]);
	});

	test("the round cap on a tool-calls-only last round says so instead of returning nothing", async () => {
		const model = scriptedModel([tc("read_file", { path: "/loop" })]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [READ_FILE_TOOL],
			call: model.call,
			maxRounds: 2,
		});
		expect(result.content).toBe(emptyReplyNote(2));
		expect(result.unverified).toEqual([emptyReplyStall(2)]);
	});

	test("a blank reply with no tool work is checked, then ends as an explicit failure (#3524)", async () => {
		for (const blank of ["", "  \n\t "]) {
			const model = scriptedModel([blank, blank, blank, blank, "UNREACHED"]);
			const result = await runTextToolAgent({
				messages: [{ role: "user", content: "hi" }],
				tools: [READ_FILE_TOOL],
				call: model.call,
			});
			expect(model.calls()).toBe(1 + MAX_CONSECUTIVE_CHECKS);
			expect(result.content).toBe(emptyReplyNote(0));
			expect(result.unverified).toEqual([emptyReplyStall(0)]);
		}
	});

	test("a blank first reply followed by a real one is returned as the answer (#3524)", async () => {
		const model = scriptedModel(["  ", "DONE: Hello.", "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "hi" }],
			tools: [READ_FILE_TOOL],
			call: model.call,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("Hello.");
		expect(result.unverified).toEqual([]);
	});

	test("a call to a tool that does not exist gets an error naming the tools that do", async () => {
		const model = scriptedModel([
			tc("read_file", { path: "README.md" }),
			tc("spawn_agent", { runtime: "8gent", model: "llama3.2:3b", task: "fix src/clamp.ts" }),
			"DONE: spawn_agent is not available here.",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Fix it with a sub-agent." }],
			tools: [READ_FILE_TOOL],
			call: model.call,
			maxRounds: 50,
		});
		const spawn = result.toolLog.find((e) => e.name === "spawn_agent");
		expect(spawn?.result).toBe(unknownToolResult("spawn_agent", ["read_file"]));
		const fedBack = model.seen[2][model.seen[2].length - 1].content;
		expect(fedBack).toContain('no tool named "spawn_agent"');
		expect(fedBack).toContain("Available tools: read_file.");
	});
});

describe("runTextToolAgent - plan check at turn end (#3098)", () => {
	const PLAN_TOOL: TextTool = {
		spec: { name: "update_plan", description: "Report plan progress", parameters: {} },
		run: async () => "Plan updated",
	};
	const plan = (...statuses: string[]) => ({
		plan: statuses.map((status, i) => ({ step: `Step ${i + 1}`, status })),
	});
	const planChecks = (seen: TextToolMessage[][]) =>
		seen.filter((m) => lastUserMessage(m).startsWith("Your plan still has steps"));

	test("the pilot shape: last update leaves a step in progress, the check names it, the model ticks it", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("update_plan", plan("in_progress", "pending")),
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			tc("update_plan", plan("done", "in_progress")),
			tc("run_command", { command: "ls deck" }),
			// The completion check comes first, as it does after any tool round.
			"DONE: Wrote deck/outline.md and listed deck.",
			"DONE: Wrote deck/outline.md and listed deck.",
			tc("update_plan", plan("done", "done")),
			"DONE: Wrote deck/outline.md and listed deck.",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write deck/outline.md, then run ls deck." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 20,
		});
		const checks = planChecks(model.seen);
		expect(checks).toHaveLength(1);
		expect(lastUserMessage(checks[0])).toContain("- Step 2 (in_progress)");
		expect(lastUserMessage(checks[0])).not.toContain("Step 1");
		// The harness ticked nothing: the only all-done update is the model's own.
		const updates = result.toolLog.filter((t) => t.name === "update_plan");
		expect(updates).toHaveLength(3);
		expect(openPlanSteps(result.toolLog)).toEqual([]);
		expect(result.content).toBe("Wrote deck/outline.md and listed deck.");
		expect(result.unverified).toEqual([]);
	});

	test("at most once per turn: a model that ignores the check still ends, the plan as it left it", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("update_plan", plan("done", "in_progress")),
			tc("run_command", { command: "ls deck" }),
			"DONE: Listed deck.",
			"DONE: Listed deck.",
			"DONE: Listed deck.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Run ls deck." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 20,
		});
		expect(planChecks(model.seen)).toHaveLength(1);
		expect(result.content).toBe("Listed deck.");
		expect(openPlanSteps(result.toolLog).map((s) => s.step)).toEqual(["Step 2"]);
	});

	test("no check when every step is done or failed, when there is no plan, or for a question", async () => {
		for (const script of [
			[tc("update_plan", plan("done", "failed")), tc("run_command", { command: "ls deck" }), "DONE: Listed deck."],
			[tc("run_command", { command: "ls deck" }), "DONE: Listed deck."],
			[tc("update_plan", plan("done", "pending")), tc("run_command", { command: "ls deck" }), "Which folder next?"],
		]) {
			const ws = fakeWorkspace();
			const model = scriptedModel([...script, "DONE: Listed deck."]);
			await runTextToolAgent({
				messages: [{ role: "user", content: "Run ls deck." }],
				tools: [...ws.tools, PLAN_TOOL],
				call: model.call,
				maxRounds: 20,
			});
			expect(planChecks(model.seen)).toHaveLength(0);
		}
	});

	test("openPlanSteps reads the last update that parsed, and skips refused ones", () => {
		const log = [
			{ name: "update_plan", args: plan("in_progress", "pending"), result: "Plan updated" },
			{ name: "update_plan", args: { plan: [] }, result: "Error: update_plan: plan must be a non-empty array" },
		];
		expect(openPlanSteps(log).map((s) => s.status)).toEqual(["in_progress", "pending"]);
		expect(openPlanSteps([])).toEqual([]);
	});

	test("the check never tells the model a step is done, and names the done marker", () => {
		const msg = planCheckMessage([{ step: "Summarise", status: "in_progress" }]);
		expect(msg).toContain("- Summarise (in_progress)");
		expect(msg).toContain(DONE_MARKER);
		expect(msg).not.toMatch(/\u2014/);
	});
});


describe("runTextToolAgent - caller final check (#3550)", () => {
	const WRITE_TOOL: TextTool = {
		spec: {
			name: "write_file",
			description: "Write a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		run: async () => "wrote /tmp/x.txt",
	};
	const writeCall = [
		"```tool_call",
		'{"name": "write_file", "arguments": {"path": "/tmp/x.txt"}}',
		"```",
	].join("\n");
	const CHECK = "SENTINEL_3550_final_check";
	const scripted = (replies: string[]) => {
		const seen: TextToolMessage[][] = [];
		let i = 0;
		const call = async (msgs: TextToolMessage[]): Promise<string> => {
			seen.push(msgs);
			return replies[Math.min(i++, replies.length - 1)];
		};
		return { seen, call };
	};
	const sentChecks = (seen: TextToolMessage[][]) =>
		(seen[seen.length - 1] ?? []).filter((m) => m.role === "user" && m.content === CHECK);

	test("a non-null final check is sent once, then the turn ends", async () => {
		const model = scripted([writeCall, "DONE: wrote it."]);
		let asked = 0;
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write x" }],
			tools: [WRITE_TOOL],
			call: model.call,
			finalCheck: () => {
				asked++;
				return CHECK;
			},
		});
		expect(asked).toBe(1);
		expect(sentChecks(model.seen)).toHaveLength(1);
		expect(result.content).toBe("wrote it.");
	});

	test("a null final check lets the answer through", async () => {
		const model = scripted([writeCall, "DONE: wrote it."]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "write x" }],
			tools: [WRITE_TOOL],
			call: model.call,
			finalCheck: () => null,
		});
		expect(sentChecks(model.seen)).toHaveLength(0);
		expect(result.content).toBe("wrote it.");
	});

	test("no final check option keeps the old round count", async () => {
		const withOut = scripted([writeCall, "DONE: wrote it."]);
		const a = await runTextToolAgent({
			messages: [{ role: "user", content: "write x" }],
			tools: [WRITE_TOOL],
			call: withOut.call,
		});
		const withNull = scripted([writeCall, "DONE: wrote it."]);
		const b = await runTextToolAgent({
			messages: [{ role: "user", content: "write x" }],
			tools: [WRITE_TOOL],
			call: withNull.call,
			finalCheck: () => null,
		});
		expect(b.rounds).toBe(a.rounds);
	});
});

// ── An update_plan-only round is not progress (SIGI G3 baseline, 7 Oct 2026; #3639) ──
//
// The planning gate asks for a PLAN and an update_plan call. On a direct
// question, qwen3.8 27B obliged: round 1 was the plan plus update_plan, round 2
// the one-line answer. That answer followed a "successful tool round", so the
// completion check fired and the model answered it with "DONE: I analyzed the
// question and ...", which became the final text. 13 of 13 harness runs that
// called update_plan failed the first-line check; 8 of 11 that did not passed.
// None of these tests uses a scored item: the prompts are invented.

describe("runTextToolAgent - an update_plan-only round is not progress (#3639)", () => {
	const PLAN_TOOL: TextTool = {
		spec: { name: "update_plan", description: "Report plan progress", parameters: {} },
		run: async () => "Plan updated",
	};
	const plan = (...statuses: string[]) => ({
		plan: statuses.map((status, i) => ({ step: `Step ${i + 1}`, status })),
	});
	const isPlanCheck = (msgs: TextToolMessage[]) =>
		lastUserMessage(msgs).startsWith("Your plan still has steps");
	const QUESTION = "Is a bare assertion of residence enough to plead citizenship? Reply with Yes or No on the first line.";

	test("the G3 shape: plan + update_plan, then a one-line answer, is final with no check", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			`PLAN: 1. Read the rule 2. Answer\n${tc("update_plan", plan("done", "done"))}`,
			"No",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: QUESTION }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 6,
		});
		expect(model.calls()).toBe(2);
		expect(result.rounds).toBe(2);
		expect(model.seen.filter(isCheck)).toHaveLength(0);
		expect(model.seen.filter(isPlanCheck)).toHaveLength(0);
		expect(result.content).toBe("No");
		expect(result.toolLog.map((t) => t.name)).toEqual(["update_plan"]);
		expect(result.unverified).toEqual([]);
	});

	test("two update_plan-only rounds in a row still arm nothing", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("update_plan", plan("in_progress", "pending")),
			tc("update_plan", plan("done", "done")),
			"Yes",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: QUESTION }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 6,
		});
		expect(model.calls()).toBe(3);
		expect(model.seen.filter(isCheck)).toHaveLength(0);
		expect(result.content).toBe("Yes");
	});

	test("the plan check (#3098) still fires when the update_plan-only round leaves a step open", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("update_plan", plan("done", "in_progress")),
			"No",
			tc("update_plan", plan("done", "done")),
			"DONE: No",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: QUESTION }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 6,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(0);
		expect(model.seen.filter(isPlanCheck)).toHaveLength(1);
		expect(result.content).toBe("No");
	});

	test("a round that runs update_plan AND a real tool is still a tool round: the prose after it is checked (#3091)", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			`${tc("update_plan", plan("in_progress", "pending"))}\n${tc("run_command", { command: "ls deck" })}`,
			"Now writing the outline.",
			tc("write_file", { path: "deck/outline.md", content: "x" }),
			tc("update_plan", plan("done", "done")),
			"DONE: Listed deck and wrote deck/outline.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Run ls deck, then write deck/outline.md." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 10,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(isCheck(model.seen[2])).toBe(true);
		expect(ws.files.get("deck/outline.md")).toBe("x");
		// Real work ran after the check, so the announcement is not kept.
		expect(result.content).toBe("Listed deck and wrote deck/outline.md.");
	});

	test("a refused update_plan alone is not an all-refused round either", async () => {
		const ws = fakeWorkspace();
		const failingPlan: TextTool = {
			spec: PLAN_TOOL.spec,
			run: async () => "Error: update_plan: plan must be a non-empty array",
		};
		const model = scriptedModel([tc("update_plan", { plan: [] }), "No", "UNREACHED"]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: QUESTION }],
			tools: [...ws.tools, failingPlan],
			call: model.call,
			maxRounds: 6,
		});
		expect(model.calls()).toBe(2);
		expect(result.content).toBe("No");
	});

	// 8SO probes (review of #3645 at eac63bfe): an update_plan-only round must
	// be transparent to the stall state, not reset it. It neither answers a
	// pending check nor forgets a blocked round.
	test("probe A: write_file, announcement, check, update_plan, another announcement: re-checked, not returned", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			"Now creating the deck from the outline.",
			tc("update_plan", plan("done", "in_progress")),
			"Creating deck/deck.md now.",
			tc("write_file", { path: "deck/deck.md", content: "# What" }),
			tc("update_plan", plan("done", "done")),
			"DONE: Wrote deck/outline.md and deck/deck.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write deck/outline.md, then deck/deck.md." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 10,
		});
		// Check 1 after the first announcement; the plan-only round does not
		// answer it, so the second announcement gets check 2. The closing
		// update_plan keeps the plan check (#3098) out of this probe.
		expect(model.seen.filter(isCheck)).toHaveLength(2);
		expect(isCheck(model.seen[2])).toBe(true);
		expect(isCheck(model.seen[4])).toBe(true);
		expect(ws.files.get("deck/deck.md")).toBe("# What");
		expect(model.calls()).toBe(7);
		expect(result.content).toBe("Wrote deck/outline.md and deck/deck.md.");
	});

	test("probe C: a blocked push, 'Pushing now.', blocked check, update_plan, 'Pushed to main.': the blocked note is carried", async () => {
		const ws = gatedWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: RUN_014230_CHAIN_CMD }),
			"Pushing now.",
			tc("update_plan", plan("done", "done")),
			// Repeated by the scripted model: the turn ends on this line at the cap.
			"Pushed to main.",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Push the branch to main." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 10,
		});
		const blockedChecks = model.seen.map(lastUserMessage).filter((m) => m.startsWith("Your last tool calls were blocked"));
		expect(blockedChecks).toHaveLength(1);
		// The plan-only round did not answer the blocked check: "Pushed to main."
		// is checked again, then the cap ends the turn with the note.
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_CONSECUTIVE_CHECKS - 1);
		expect(ws.commands).toEqual([]);
		expect(result.content).toContain(blockedStopNote([CHAIN_REASON]));
		expect(result.content).toStartWith("Pushed to main.");
	});

	test("probe D (keepAnswerFirst): a plan-only round after a sent check drops the stale pre-check reply", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "a.md", content: "a" }),
			"Now writing b.md.",
			tc("update_plan", plan("done", "done")),
			"DONE: Wrote a.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write a.md." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 10,
			keepAnswerFirst: true,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Wrote a.md.");
		expect(result.content).not.toContain("Now writing b.md.");
	});

	test("a plan-only round after a real round keeps that round's state: the prose after it is still checked", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			tc("update_plan", plan("done", "in_progress")),
			"Now creating the deck from the outline.",
			tc("write_file", { path: "deck/deck.md", content: "# What" }),
			tc("update_plan", plan("done", "done")),
			"DONE: Wrote deck/outline.md and deck/deck.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write deck/outline.md, then deck/deck.md." }],
			tools: [...ws.tools, PLAN_TOOL],
			call: model.call,
			maxRounds: 10,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(isCheck(model.seen[3])).toBe(true);
		expect(ws.files.get("deck/deck.md")).toBe("# What");
		expect(model.calls()).toBe(6);
		expect(result.content).toBe("Wrote deck/outline.md and deck/deck.md.");
	});
});

// ── The completion check keeps the answer (8CO finding, #3638) ──────────────
//
// After any real tool round the next prose reply is checked. When the model
// answers that check with "DONE: <summary>" and ran nothing in between, the
// reply before the check was its answer. The turn used to return the summary
// alone ("I listed the files and ..."), which a first-line or exact-match
// reader scores as wrong. The check still goes out; the return value changes.

describe("runTextToolAgent - the completion check keeps the answer first (#3638, keepAnswerFirst)", () => {
	test("tool round, answer, check, DONE summary: with the option on, the final text starts with the answer", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: "ls deck" }),
			"Yes",
			"DONE: I listed the deck folder and answered the question.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Check deck/ and say whether it has an outline. Yes or No on the first line." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 6,
			keepAnswerFirst: true,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(model.calls()).toBe(3);
		expect(result.content).toBe("Yes\n\nI listed the deck folder and answered the question.");
		expect(result.content.split("\n")[0]).toBe("Yes");
	});

	test("a summary that already starts with the answer is returned as it is", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: "ls deck" }),
			"No",
			"DONE: No. The folder has no outline; I listed it to check.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Does deck/ have an outline?" }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 6,
			keepAnswerFirst: true,
		});
		expect(result.content).toBe("No. The folder has no outline; I listed it to check.");
	});

	test("the real build flow is unchanged with the option on: an announcement, a check, more tools, DONE returns the summary alone", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			"Now creating the deck from the outline.",
			tc("write_file", { path: "deck/deck.md", content: "# What" }),
			"DONE: Wrote deck/outline.md and deck/deck.md.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write deck/outline.md, then deck/deck.md." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 10,
			keepAnswerFirst: true,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("Wrote deck/outline.md and deck/deck.md.");
		expect(result.content).not.toContain("Now creating");
	});

	test("an unanswered check keeps the cap with the option on: two checks, then the last prose, as before", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("run_command", { command: "pwd" }),
			"Let me look at the deck next.",
			"Starting now.",
			"Starting now.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Run pwd, then write deck/outline.md." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 10,
			keepAnswerFirst: true,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(MAX_CONSECUTIVE_CHECKS);
		expect(result.content).toStartWith("Starting now.");
		expect(result.content).not.toContain("Let me look");
	});

	test("interactive (option off): tool round, a real summary, the check, DONE with the same summary: shown once", async () => {
		const ws = fakeWorkspace();
		const model = scriptedModel([
			tc("write_file", { path: "deck/outline.md", content: "1. What" }),
			"I wrote deck/outline.md with the outline.",
			"DONE: I wrote deck/outline.md with the outline.",
			"UNREACHED",
		]);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Write deck/outline.md." }],
			tools: ws.tools,
			call: model.call,
			maxRounds: 6,
		});
		expect(model.seen.filter(isCheck)).toHaveLength(1);
		expect(result.content).toBe("I wrote deck/outline.md with the outline.");
		expect(result.content.match(/I wrote deck/g)).toHaveLength(1);
	});

	test("interactive (option off): a reworded DONE summary stands alone, and a bare DONE still falls back to the reply before the check", async () => {
		for (const [done, expected] of [
			["DONE: Outline written to deck/outline.md.", "Outline written to deck/outline.md."],
			["DONE:", "I wrote deck/outline.md."],
		]) {
			const ws = fakeWorkspace();
			const model = scriptedModel([
				tc("write_file", { path: "deck/outline.md", content: "1. What" }),
				"I wrote deck/outline.md.",
				done,
				"UNREACHED",
			]);
			const result = await runTextToolAgent({
				messages: [{ role: "user", content: "Write deck/outline.md." }],
				tools: ws.tools,
				call: model.call,
				maxRounds: 6,
			});
			expect(result.content).toBe(expected);
		}
	});

	test("the option changes what is returned, never what is sent: the same check goes out either way", async () => {
		const seen: string[][] = [];
		for (const keepAnswerFirst of [false, true]) {
			const ws = fakeWorkspace();
			const model = scriptedModel([tc("run_command", { command: "ls deck" }), "Yes", "DONE: I listed deck.", "UNREACHED"]);
			await runTextToolAgent({
				messages: [{ role: "user", content: "Is deck/ empty? Yes or No." }],
				tools: ws.tools,
				call: model.call,
				maxRounds: 6,
				keepAnswerFirst,
			});
			seen.push(model.seen.map(lastUserMessage));
		}
		expect(seen[0]).toEqual(seen[1]);
		expect(seen[0].filter((m) => m === COMPLETION_CHECK_MESSAGE)).toHaveLength(1);
	});
});

// #3641: a tool result that carries an image puts the pixels on the next
// message's `images`, never in the text the model, the log or the result
// block see. The headless baseline could not measure any screen task because
// read_image returned metadata only.
describe("image attachments on tool results (#3641)", () => {
	const PNG = "iVBORw0KGgo=";
	const READ_IMAGE_TOOL: TextTool = {
		spec: {
			name: "read_image",
			description: "Read an image",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		run: async () => imageAttachmentResult('{"width": 64, "height": 48}', "image/png", PNG),
	};

	test("splitImageAttachment: text stays, the data URL comes out, plain results are untouched", () => {
		const split = splitImageAttachment(imageAttachmentResult("meta", "image/png", PNG));
		expect(split.text).toBe("meta");
		expect(split.images).toEqual([`data:image/png;base64,${PNG}`]);
		expect(splitImageAttachment("just text")).toEqual({ text: "just text", images: [] });
		// A marker without a data URL attaches nothing and is dropped from the text.
		expect(splitImageAttachment(`x\n${IMAGE_ATTACHMENT_MARKER} nope`)).toEqual({ text: "x", images: [] });
	});

	test("the image rides on the follow-up user message; text, log and result block carry no pixels", async () => {
		const seen: TextToolMessage[][] = [];
		let turn = 0;
		const call = async (messages: TextToolMessage[]): Promise<string> => {
			seen.push(messages);
			turn++;
			if (turn === 1) {
				return ["```tool_call", '{"name": "read_image", "arguments": {"path": "shot.png"}}', "```"].join("\n");
			}
			return "DONE: Click the Save button.";
		};

		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "The screenshot is shot.png. Where do I click?" }],
			tools: [READ_IMAGE_TOOL],
			call,
		});

		expect(result.content).toBe("Click the Save button.");
		// The log keeps the metadata, not the marker or the base64.
		expect(result.toolLog).toHaveLength(1);
		expect(result.toolLog[0].result).toBe('{"width": 64, "height": 48}');
		expect(result.toolLog[0].result).not.toContain(IMAGE_ATTACHMENT_MARKER);

		// The second request: the tool-result user message has the image on
		// `images` and the metadata in its text.
		const followUp = seen[1].filter((m) => m.role === "user").at(-1);
		expect(followUp?.images).toEqual([`data:image/png;base64,${PNG}`]);
		expect(followUp?.content).toContain("Tool read_image returned:");
		expect(followUp?.content).toContain('{"width": 64, "height": 48}');
		expect(followUp?.content).not.toContain(IMAGE_ATTACHMENT_MARKER);
		expect(followUp?.content).not.toContain(PNG);
		// No other message grew an image.
		expect(seen[1].filter((m) => m.images).length).toBe(1);
	});

	test("a text-only tool result adds no images field at all", async () => {
		const seen: TextToolMessage[][] = [];
		let turn = 0;
		const call = async (messages: TextToolMessage[]): Promise<string> => {
			seen.push(messages);
			turn++;
			if (turn === 1) {
				return ["```tool_call", '{"name": "read_file", "arguments": {"path": "a.txt"}}', "```"].join("\n");
			}
			return "DONE: 4242.";
		};
		await runTextToolAgent({
			messages: [{ role: "user", content: "What is the secret?" }],
			tools: [READ_FILE_TOOL],
			call,
		});
		expect(seen[1].every((m) => !("images" in m))).toBe(true);
	});
});
