/**
 * #3199: the same run_command text refused for chaining twice in one turn gets one
 * plain line saying what does work. No retry logic: the line is the whole change.
 */

import { describe, expect, test } from "bun:test";
import { REFUSED_TWICE_LINE } from "../permissions/cd-prefix";
import type { TextToolMessage } from "./text-tool-client";
import { type TextTool, runTextToolAgent } from "./text-tool-loop";

function tc(name: string, args: Record<string, unknown>): string {
	return ["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");
}

function scriptedModel(script: string[]) {
	const seen: TextToolMessage[][] = [];
	let i = 0;
	const call = async (messages: TextToolMessage[]): Promise<string> => {
		seen.push(messages);
		return script[Math.min(i++, script.length - 1)] as string;
	};
	return { call, seen };
}

const lastUserMessage = (msgs: TextToolMessage[]) =>
	[...msgs].reverse().find((m) => m.role === "user")?.content ?? "";

/** run_command that refuses `;` and `&&` the way the sanitizer words it. */
function chainRefusingShell() {
	const ran: string[] = [];
	const tools: TextTool[] = [
		{
			spec: { name: "run_command", description: "Run a command", parameters: {} },
			run: async (a) => {
				const cmd = String(a.command);
				if (cmd.includes("&&"))
					return `[BLOCKED] Command chaining with && is not allowed. Use separate run_command calls instead. Command: ${cmd}`;
				if (cmd.includes(";"))
					return `[BLOCKED] Semicolon command chaining is not allowed. Use separate run_command calls instead. Command: ${cmd}`;
				ran.push(cmd);
				return "ok";
			},
		},
	];
	return { tools, ran };
}

async function turn(commands: string[]) {
	const shell = chainRefusingShell();
	const model = scriptedModel([
		...commands.map((command) => tc("run_command", { command })),
		"DONE: stopped.",
		"DONE: stopped.",
	]);
	await runTextToolAgent({
		messages: [{ role: "user", content: "Build the video." }],
		tools: shell.tools,
		call: model.call,
		maxRounds: 20,
	});
	return { results: model.seen.slice(1, commands.length + 1).map(lastUserMessage), ran: shell.ran };
}

describe("runTextToolAgent - the same chained command refused twice (#3199)", () => {
	test("the second refusal of the same text carries the line once; the first does not", async () => {
		const { results } = await turn(["ls x; ls y", "ls x; ls y"]);
		expect(results[0]).not.toContain(REFUSED_TWICE_LINE);
		expect(results[1]).toContain(`\n${REFUSED_TWICE_LINE}`);
		expect(results[1].split(REFUSED_TWICE_LINE).length).toBe(2);
	});

	test("different chained texts never earn it, only their count", async () => {
		const { results } = await turn(["ls a; ls b", "ls c && ls d", "ls e; ls f"]);
		for (const r of results) expect(r).not.toContain(REFUSED_TWICE_LINE);
		expect(results[2]).toContain("3 chained commands refused this turn");
	});

	test("a third refusal of the same text still carries it, and a plain command never does", async () => {
		const { results, ran } = await turn(["a && b", "a && b", "a && b", "ls"]);
		expect(results[1]).toContain(REFUSED_TWICE_LINE);
		expect(results[2]).toContain(REFUSED_TWICE_LINE);
		expect(results[3]).not.toContain(REFUSED_TWICE_LINE);
		expect(ran).toEqual(["ls"]);
	});

	test("the line says what works, in plain words", () => {
		expect(REFUSED_TWICE_LINE).toBe(
			"Refused twice. Chaining is not allowed; run the steps as separate commands, or prefix one `cd <folder> &&` to run inside a project folder.",
		);
	});
});
