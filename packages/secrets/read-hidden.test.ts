import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { MAX_PIPED_BYTES, readHidden } from "./read-hidden";

/** A fake TTY stdin that records raw mode and lets a test push keystrokes. */
function fakeTty() {
	const e = new EventEmitter() as EventEmitter & Record<string, unknown>;
	const state = { raw: false, paused: true };
	Object.assign(e, {
		isTTY: true,
		setRawMode: (on: boolean) => {
			state.raw = on;
		},
		setEncoding: () => {},
		pause: () => {
			state.paused = true;
		},
		resume: () => {
			state.paused = false;
		},
	});
	return { stdin: e as never, state, emit: (ev: string, a?: unknown) => e.emit(ev, a) };
}

const quiet = () => {
	const out: string[] = [];
	return { out, stderr: { write: (s: string) => out.push(s) } };
};

describe("readHidden (8SO #4681)", () => {
	test("Enter returns the line, restores echo, never prints the value", async () => {
		const t = fakeTty();
		const q = quiet();
		const p = readHidden("key: ", { stdin: t.stdin, stderr: q.stderr });
		expect(t.state.raw).toBe(true);
		t.emit("data", "secret-value\r");
		expect(await p).toBe("secret-value");
		expect(t.state.raw).toBe(false);
		expect(q.out.join("")).not.toContain("secret");
	});
	test("Ctrl+C restores echo before exiting 130", async () => {
		const t = fakeTty();
		let code = -1;
		const p = readHidden("key: ", {
			stdin: t.stdin,
			stderr: quiet().stderr,
			exit: (c) => {
				code = c;
			},
		});
		t.emit("data", "abc\u0003");
		expect(await p).toBe("");
		expect(code).toBe(130);
		expect(t.state.raw).toBe(false);
	});
	test("stream end restores echo", async () => {
		const t = fakeTty();
		const p = readHidden("key: ", { stdin: t.stdin, stderr: quiet().stderr });
		t.emit("data", "partial");
		t.emit("end");
		expect(await p).toBe("partial");
		expect(t.state.raw).toBe(false);
	});
	test("stream error restores echo and rejects without the value", async () => {
		const t = fakeTty();
		const p = readHidden("key: ", { stdin: t.stdin, stderr: quiet().stderr });
		t.emit("data", "partial-secret");
		t.emit("error", new Error("EIO"));
		await expect(p).rejects.toThrow("EIO");
		expect(t.state.raw).toBe(false);
	});
	test("piped input takes the first line only", async () => {
		const stdin = Readable.from([Buffer.from("first-line\nEIGHT_SHELL_ENV_X=1\n")]);
		expect(await readHidden("", { stdin: stdin as never })).toBe("first-line");
	});
	test("piped input is bounded", async () => {
		const big = Buffer.alloc(MAX_PIPED_BYTES * 4, 0x61);
		const stdin = Readable.from([big]);
		const got = await readHidden("", { stdin: stdin as never });
		expect(got.length).toBe(MAX_PIPED_BYTES);
	});
});
