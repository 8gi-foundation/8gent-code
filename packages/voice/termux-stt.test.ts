import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	LISTEN_TIMEOUT_MS,
	type SttChild,
	listenOnce,
	missingAppLine,
	noSpeechLine,
	timeoutLine,
} from "./termux-stt";

type Fake = SttChild & EventEmitter & { stdout: EventEmitter };

/** A fake child: `act` drives it after the call spawns it. No process is ever started. */
function rig(act: (c: Fake) => void, timeoutMs = 50) {
	const calls: { cmd: string; args: string[] }[] = [];
	let killed = false;
	const spawn = (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		const c = new EventEmitter() as unknown as Fake;
		c.stdout = new EventEmitter();
		c.kill = () => {
			killed = true;
			return true;
		};
		setTimeout(() => act(c), 5);
		return c;
	};
	return { run: () => listenOnce({ spawn, timeoutMs }), calls, killed: () => killed };
}

describe("listenOnce", () => {
	test("runs termux-speech-to-text with no flags and returns the last spoken line", async () => {
		const r = rig((c) => {
			c.stdout.emit("data", Buffer.from("hello wor\nhello world\n"));
			c.emit("close", 0);
		});
		expect(await r.run()).toEqual({ text: "hello world" });
		expect(r.calls).toEqual([{ cmd: "termux-speech-to-text", args: [] }]);
	});

	test("escape codes and control characters never reach the prompt", async () => {
		const r = rig((c) => {
			c.stdout.emit("data", Buffer.from("run \x1b[31mls\x07 now\n"));
			c.emit("close", 0);
		});
		expect(await r.run()).toEqual({ text: "run [31mls now" });
	});

	test("binary missing: says to install termux-api", async () => {
		const r = rig((c) => c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })));
		expect(await r.run()).toEqual({ error: missingAppLine });
		expect(missingAppLine).toContain("pkg install termux-api");
	});

	test("silence, or no mic permission: empty output names both causes in one line", async () => {
		const r = rig((c) => c.emit("close", 0));
		expect(await r.run()).toEqual({ error: noSpeechLine });
		expect(noSpeechLine).toContain("Termux:API");
		expect(noSpeechLine).toContain("microphone");
		expect(noSpeechLine.includes("\n")).toBe(false);
	});

	test("nonzero exit with no text is the same one line", async () => {
		const r = rig((c) => c.emit("close", 1));
		expect(await r.run()).toEqual({ error: noSpeechLine });
	});

	test("no answer in time: kills the call and names the Termux:API app", async () => {
		const r = rig(() => {}, 30);
		expect(await r.run()).toEqual({ error: timeoutLine });
		expect(r.killed()).toBe(true);
		expect(timeoutLine).toContain("F-Droid");
	});

	test("the default wait is 30 seconds", () => {
		expect(LISTEN_TIMEOUT_MS).toBe(30_000);
	});
});
