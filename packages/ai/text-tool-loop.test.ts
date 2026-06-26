import { describe, expect, test } from "bun:test";
import { isShellFileWrite, runTextToolAgent, type TextTool } from "./text-tool-loop";
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
