import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import {
	INSTALLED_BUILD_NOTE,
	KEEP_RECENT,
	LINE_MAX,
	OLD_RESULT_MAX,
	RESULT_MAX,
	capLines,
	capToolResults,
	capToolText,
} from "./tool-result-cap";

const BUNDLE =
	"/data/data/com.termux/files/usr/lib/node_modules/@8gi-foundation/8gent-code/dist/index.js";

function call(id: string, command: string): ModelMessage {
	return {
		role: "assistant",
		content: [{ type: "tool-call", toolCallId: id, toolName: "run_command", input: { command } }],
	};
}
function result(id: string, value: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName: "run_command",
				output: { type: "text", value },
			},
		],
	};
}
const textOf = (m: ModelMessage) =>
	((m.content as Array<{ output: { value: string } }>)[0].output.value as string) ?? "";
const bytes = (ms: ModelMessage[]) => Buffer.byteLength(JSON.stringify(ms));

describe("tool result cap", () => {
	it("cuts one long line and says how much went", () => {
		const out = capLines(`short\n${"x".repeat(200_000)}\nend`);
		expect(out).toContain(`[${200_000 - LINE_MAX} chars cut from this line]`);
		expect(out.startsWith("short\n")).toBe(true);
		expect(out.endsWith("\nend")).toBe(true);
	});

	it("keeps head and tail under the byte cap with a truncated note", () => {
		const text = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
		const out = capToolText(text, RESULT_MAX);
		expect(Buffer.byteLength(out)).toBeLessThan(RESULT_MAX + 200);
		expect(out).toMatch(/\[truncated \d+ bytes;/);
		expect(out.startsWith("line 0 ")).toBe(true);
		expect(out).toContain("line 4999 ");
	});

	it("leaves small results and the array untouched", () => {
		const ms = [call("a", "ls"), result("a", "file.txt")];
		expect(capToolResults(ms)).toBe(ms);
	});

	it("a 15-call bundle read stays small: 2 MB request before, under 80 KB after", () => {
		// What the uncapped loop re-sent on its last step in the recorded run.
		const ms: ModelMessage[] = [{ role: "user", content: "make it better" }];
		for (let i = 0; i < 15; i++) {
			ms.push(call(`c${i}`, `sed -n '1,100p' ./dist/index.js`));
			ms.push(result(`c${i}`, `${"z".repeat(200_000)}\n${"w".repeat(200_000)}`));
		}
		expect(bytes(ms)).toBeGreaterThan(5_000_000);
		const capped = capToolResults(ms);
		expect(bytes(capped)).toBeLessThan(80_000);
		// Newest results keep more than older ones.
		const results = capped.filter((m) => m.role === "tool");
		expect(Buffer.byteLength(textOf(results.at(-1)!))).toBeLessThanOrEqual(RESULT_MAX + 200);
		expect(Buffer.byteLength(textOf(results[0]))).toBeLessThanOrEqual(OLD_RESULT_MAX + 200);
		expect(results.length).toBeGreaterThan(KEEP_RECENT);
		// The input is not changed: the TUI and history keep the full result.
		expect(textOf(ms[2]).length).toBe(400_001);
	});

	it("a read inside the installed package gets the installed-build note once", () => {
		const ms = [
			call("a", `grep -n run ${BUNDLE}`),
			result("a", "12:run()"),
			call("b", `sed -n '1,5p' ${BUNDLE}`),
			result("b", "x"),
		];
		const capped = capToolResults(ms);
		expect(textOf(capped[1]).startsWith(INSTALLED_BUILD_NOTE)).toBe(true);
		expect(textOf(capped[3])).toBe("x");
	});

	it("json results over the cap become capped text", () => {
		const ms: ModelMessage[] = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "j",
						toolName: "grep",
						output: { type: "json", value: { lines: Array(20_000).fill("abcdefgh") } },
					},
				],
			},
		];
		const out = (capToolResults(ms)[0].content as Array<{ output: { type: string } }>)[0].output;
		expect(out.type).toBe("text");
		expect(bytes(capToolResults(ms))).toBeLessThan(RESULT_MAX + 500);
	});

	it("scrubs a secret that the 2000-char line cut would split", () => {
		const prefix = "x".repeat(LINE_MAX - 20);
		const out = capToolText(`${prefix} key: AKIAIOSFODNN7EXAMPLE end`, RESULT_MAX);
		expect(out).toContain("chars cut from this line");
		expect(out).not.toContain("AKIAIOSFODNN7E");
		expect(out).toContain("[REDACTED");
	});

	it("scrubs a secret in a result under every cap", () => {
		const out = capToolText("key: AKIAIOSFODNN7EXAMPLE here", RESULT_MAX);
		expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(out).toContain("[REDACTED");
	});
});
