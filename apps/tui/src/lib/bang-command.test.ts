import { describe, expect, test } from "bun:test";
import {
	bangChatLine,
	bangContextBlock,
	parseBang,
	runBang,
	withShellContext,
} from "./bang-command.js";

describe("!cmd (#3918 D5)", () => {
	test("parseBang tells ! from !! and ignores other text", () => {
		expect(parseBang("!git status")).toEqual({ command: "git status", send: true });
		expect(parseBang("  !!ls -la ")).toEqual({ command: "ls -la", send: false });
		expect(parseBang("!")).toEqual({ command: "", send: true });
		expect(parseBang("hello !world")).toBeNull();
		expect(parseBang("/help")).toBeNull();
	});

	test("runBang runs through the shell in cwd and keeps stderr", async () => {
		const r = await runBang("echo out && echo err 1>&2 && exit 3", process.cwd());
		expect(r.exitCode).toBe(3);
		expect(r.output).toContain("out");
		expect(r.output).toContain("err");
		expect(r.timedOut).toBeFalse();
	});

	test("runBang stops a command at the timeout", async () => {
		// bun itself as the slow command: `sleep` is not on Windows.
		const slow = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`;
		const r = await runBang(slow, process.cwd(), 300);
		expect(r.timedOut).toBeTrue();
	}, 10000);

	test("chat line says where the output goes", () => {
		const r = { exitCode: 0, output: "a\nb", timedOut: false };
		expect(bangChatLine({ command: "x", send: true }, r)).toBe(
			"$ x\na\nb\n(exit 0) Goes to 8gent with your next message.",
		);
		expect(bangChatLine({ command: "x", send: false }, r)).toEndWith("Not sent to 8gent.");
		const long = { ...r, output: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") };
		const line = bangChatLine({ command: "x", send: true }, long, 5);
		expect(line).toContain("... 45 lines above");
		expect(line).toContain("l49");
		expect(line).not.toContain("l44\n");
	});

	test("context goes in front of the message, once per block", () => {
		const block = bangContextBlock(
			{ command: "git status", send: true },
			{ exitCode: 0, output: "clean", timedOut: false },
		);
		expect(block).toContain("`git status`");
		expect(block).toContain("clean");
		expect(withShellContext([block], "fix it")).toBe(`${block}\n\nfix it`);
		expect(withShellContext(undefined, "fix it")).toBe("fix it");
		expect(withShellContext([], "fix it")).toBe("fix it");
	});
});
