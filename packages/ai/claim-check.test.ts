import { describe, expect, test } from "bun:test";
import {
	checkClaims,
	claimFollowUpMessage,
	extractClaimedWrites,
	extractRequestedCommands,
	formatHarnessNote,
	isRefusedToolResult,
	type ToolLogLike,
} from "./claim-check";

// The prompt both Rishi pilot l2-solo-deck runs used (2026-09-29).
const PILOT_PROMPT =
	"Research this repo's packages/decide folder, then write deck/outline.md with 5 slides about Eight System One, then turn that outline into deck/deck.md in Marp style with --- between slides, then run ls deck and wc -l deck/deck.md, then summarise what you did.";

const WORK = "/Users/x/.8gent/rishi-pilot/runs/2026-09-29_142559/l2-solo-deck/work";

describe("extractRequestedCommands", () => {
	test("the pilot prompt asks for exactly ls deck and wc -l deck/deck.md", () => {
		expect(extractRequestedCommands(PILOT_PROMPT)).toEqual(["ls deck", "wc -l deck/deck.md"]);
	});

	test("backticked spans whose first word is a known command", () => {
		expect(extractRequestedCommands("Please check with `git status` and then `bun test packages/ai`.")).toEqual([
			"git status",
			"bun test packages/ai",
		]);
	});

	test("a backticked file path or identifier is not a command", () => {
		expect(extractRequestedCommands("Edit `packages/ai/index.ts` and rename `runTurn`.")).toEqual([]);
	});

	test("'run X' only when X starts with a known command token", () => {
		expect(extractRequestedCommands("run the tests and fix what fails")).toEqual([]);
		expect(extractRequestedCommands("Run it again.")).toEqual([]);
		expect(extractRequestedCommands("then run tsc --noEmit.")).toEqual(["tsc --noEmit"]);
	});

	test("clause boundaries end the command: comma, then, semicolon, sentence period, newline", () => {
		expect(extractRequestedCommands("run ls deck, then stop")).toEqual(["ls deck"]);
		expect(extractRequestedCommands("run pwd then tell me")).toEqual(["pwd"]);
		expect(extractRequestedCommands("run wc -l deck/deck.md. Then stop.")).toEqual(["wc -l deck/deck.md"]);
		expect(extractRequestedCommands("run ls deck; summarise")).toEqual(["ls deck"]);
		expect(extractRequestedCommands("run ls deck\nthen summarise")).toEqual(["ls deck"]);
	});

	test("'and' joins two commands only when both halves start with a known command", () => {
		expect(extractRequestedCommands("run ls deck and tell me what is there")).toEqual(["ls deck"]);
	});

	test("words that merely contain 'run' do not trigger", () => {
		expect(extractRequestedCommands("rerun ls deck, running wc -l x.md is fine")).toEqual([]);
	});

	test("a backticked command after 'run' is counted once", () => {
		expect(extractRequestedCommands("run `ls deck` and report")).toEqual(["ls deck"]);
	});

	test("no commands in a plain request", () => {
		expect(extractRequestedCommands("make a deck about the decide package")).toEqual([]);
	});
});

describe("isRefusedToolResult", () => {
	test("errors and every BLOCKED shape are refusals", () => {
		expect(isRefusedToolResult("Error: no such file")).toBe(true);
		expect(isRefusedToolResult("[BLOCKED] Command chaining with && is not allowed.")).toBe(true);
		expect(isRefusedToolResult("[TOOLG8 BLOCKED] [no-secrets-in-files] Cannot write")).toBe(true);
	});

	test("a command that ran, even with a non-zero exit, is not a refusal", () => {
		expect(isRefusedToolResult("Exit code 1:\n\ngrep: no match")).toBe(false);
		expect(isRefusedToolResult("      62 deck/deck.md\n")).toBe(false);
		expect(isRefusedToolResult("File written and opened: /x/deck/outline.md")).toBe(false);
	});
});

describe("extractClaimedWrites", () => {
	test("explicit paths in a past-tense write sentence", () => {
		expect(extractClaimedWrites("Wrote `deck/outline.md` and deck/deck.md.", [])).toEqual([
			"deck/outline.md",
			"deck/deck.md",
		]);
	});

	test("a requested file named by its stem, when the sentence gives no path (run 6)", () => {
		expect(extractClaimedWrites("Good, the outline was written. Now let me write the Marp deck:", ["deck/outline.md", "deck/deck.md"])).toEqual([
			"deck/outline.md",
		]);
	});

	test("future tense, negation, and read-only mentions are not write claims", () => {
		const req = ["deck/outline.md", "deck/deck.md"];
		expect(extractClaimedWrites("Now let me write deck/deck.md:", req)).toEqual([]);
		expect(extractClaimedWrites("deck/outline.md was not written because the write was blocked.", req)).toEqual([]);
		expect(extractClaimedWrites("I read `README.md`, `index.ts` and packages/decide/types.ts.", req)).toEqual([]);
	});

	test("version numbers and prose with dots are not paths", () => {
		expect(extractClaimedWrites("Created release v0.17.3 notes on Bun 1.3.14, etc. All good.", [])).toEqual([]);
	});
});

const ok = (name: string, args: Record<string, unknown>, result: string): ToolLogLike => ({ name, args, result });

describe("checkClaims", () => {
	test("run 9 (2026-09-29_142559): ls deck was blocked and replaced by list_files; wc ran with an absolute path", () => {
		const log: ToolLogLike[] = [
			ok("list_files", { path: "packages/decide" }, "index.ts\nREADME.md"),
			ok("read_file", { path: "packages/decide/README.md" }, "# @8gent/decide"),
			ok("write_file", { path: "deck/outline.md", content: "x" }, `File written and opened: ${WORK}/deck/outline.md`),
			ok("write_file", { path: "deck/deck.md", content: "y" }, `File written and opened: ${WORK}/deck/deck.md`),
			ok(
				"run_command",
				{ command: `cd ${WORK} && ls deck && echo '---' && wc -l deck/deck.md` },
				`[BLOCKED] Command chaining with && is not allowed. Use separate run_command calls instead. Command: cd ${WORK} && ls deck`,
			),
			ok("list_files", { path: `${WORK}/deck` }, "deck.md\noutline.md"),
			ok("run_command", { command: `wc -l ${WORK}/deck/deck.md` }, `      62 ${WORK}/deck/deck.md\n`),
		];
		const answer =
			"DONE. All requested steps are complete and backed by tool results:\n\n2. **Wrote `deck/outline.md`** with 5 slides.\n\n3. **Wrote `deck/deck.md`** in Marp style.\n\n4. **Verified on disk**:\n   - `ls deck` → `deck.md`, `outline.md`\n   - `wc -l deck/deck.md` → **62 lines**";
		const out = checkClaims({ request: PILOT_PROMPT, answer, toolLog: log });
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe("command");
		expect(out[0].target).toBe("ls deck");
		expect(out[0].mentioned).toBe(true);
		expect(out[0].reason).toContain("blocked");
		expect(formatHarnessNote(out)).toBe(
			"[harness] Not verified: 'ls deck' was requested but never ran (its only attempt was blocked).",
		);
		const followUp = claimFollowUpMessage(out);
		expect(followUp).toContain("Your summary says `ls deck` ran");
		expect(followUp).toContain("[BLOCKED] Command chaining");
		expect(followUp).toMatch(/tool call, or correct your summary/);
	});

	test("run 6 (2026-09-29_125252): the outline write was blocked, then the model said it was written", () => {
		const log: ToolLogLike[] = [
			ok("read_file", { path: "packages/decide/README.md" }, "# @8gent/decide"),
			ok(
				"write_file",
				{ path: "deck/outline.md", content: "x" },
				"[TOOLG8 BLOCKED] [no-secrets-in-files] Cannot write secrets or credentials to files.",
			),
			ok("run_command", { command: "mkdir -p deck" }, "Command completed successfully."),
		];
		const out = checkClaims({
			request: PILOT_PROMPT,
			answer: "Good, the outline was written. Now let me write the Marp deck:",
			toolLog: log,
		});
		expect(out.map((u) => `${u.kind}:${u.target}`)).toEqual([
			"command:ls deck",
			"command:wc -l deck/deck.md",
			"file:deck/outline.md",
		]);
		const file = out.find((u) => u.kind === "file")!;
		expect(file.reason).toContain("[TOOLG8 BLOCKED]");
		expect(formatHarnessNote(out)).toContain(
			"'deck/outline.md' was reported written but its last write was blocked",
		);
	});

	test("a truthful answer has nothing unfulfilled", () => {
		const log: ToolLogLike[] = [
			ok("write_file", { path: "deck/outline.md", content: "x" }, "Wrote deck/outline.md"),
			ok("write_file", { path: "deck/deck.md", content: "y" }, "Wrote deck/deck.md"),
			ok("run_command", { command: "ls deck" }, "deck.md\noutline.md"),
			ok("run_command", { command: "wc -l deck/deck.md" }, "3 deck/deck.md"),
		];
		const out = checkClaims({
			request: PILOT_PROMPT,
			answer: "Wrote deck/outline.md and deck/deck.md, listed deck, counted 3 lines.",
			toolLog: log,
		});
		expect(out).toEqual([]);
	});

	test("the last write attempt decides: an earlier success does not cover a later blocked write", () => {
		const log: ToolLogLike[] = [
			ok("write_file", { path: "deck/outline.md", content: "x" }, "Wrote deck/outline.md"),
			ok("edit_file", { path: "deck/outline.md" }, "Error: oldText not found"),
		];
		const out = checkClaims({ request: "write deck/outline.md", answer: "Updated deck/outline.md.", toolLog: log });
		expect(out.map((u) => u.target)).toEqual(["deck/outline.md"]);
	});

	test("a later success after a blocked write fulfils the claim", () => {
		const log: ToolLogLike[] = [
			ok("write_file", { path: "deck/outline.md" }, "[TOOLG8 BLOCKED] no"),
			ok("write_file", { path: "deck/outline.md" }, "Wrote deck/outline.md"),
		];
		expect(checkClaims({ request: "write deck/outline.md", answer: "Wrote deck/outline.md.", toolLog: log })).toEqual([]);
	});

	test("files outside the request are only policed when the log contradicts the claim", () => {
		const log: ToolLogLike[] = [
			ok("write_file", { path: "deck/outline.md" }, "Wrote deck/outline.md"),
			ok("run_command", { command: "bun run build" }, "built dist/index.js"),
		];
		// Created by a build, never by write_file: not flagged.
		expect(
			checkClaims({
				request: "write deck/outline.md",
				answer: "Wrote deck/outline.md and generated dist/index.js. I read README.md and index.ts.",
				toolLog: log,
			}),
		).toEqual([]);
		// Outside the request but the log shows the write was blocked: flagged.
		const blocked = [...log, ok("write_file", { path: "notes/todo.md" }, "[TOOLG8 BLOCKED] no")];
		expect(
			checkClaims({ request: "write deck/outline.md", answer: "Wrote deck/outline.md and notes/todo.md.", toolLog: blocked }).map(
				(u) => u.target,
			),
		).toEqual(["notes/todo.md"]);
	});

	test("a requested file created by a successful shell command is not flagged", () => {
		const log: ToolLogLike[] = [ok("run_command", { command: "marp deck/deck.md -o deck/deck.html" }, "done")];
		expect(
			checkClaims({ request: "render deck/deck.html", answer: "Created deck/deck.html.", toolLog: log }),
		).toEqual([]);
	});

	test("extra flags on the executed command still satisfy the request", () => {
		const log: ToolLogLike[] = [ok("run_command", { command: "ls -la ./deck/" }, "deck.md")];
		expect(checkClaims({ request: "run ls deck", answer: "Listed it.", toolLog: log })).toEqual([]);
	});

	test("a command that ran with a non-zero exit counts as run", () => {
		const log: ToolLogLike[] = [ok("run_command", { command: "grep -r TODO src" }, "Exit code 1:\n\n")];
		expect(checkClaims({ request: "run `grep -r TODO src`", answer: "No TODOs.", toolLog: log })).toEqual([]);
	});

	test("an unmentioned requested command is reported as asked-for, not as claimed", () => {
		const out = checkClaims({ request: "run ls deck", answer: "All done.", toolLog: [ok("read_file", { path: "a.md" }, "x")] });
		expect(out[0].mentioned).toBe(false);
		expect(claimFollowUpMessage(out)).toContain("The user asked you to run `ls deck`");
		expect(formatHarnessNote(out)).toBe("[harness] Not verified: 'ls deck' was requested but never ran.");
	});
});
