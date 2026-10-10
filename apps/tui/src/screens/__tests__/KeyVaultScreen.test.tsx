/**
 * /keys screen (#3848): masked entry, key never rendered, list shows last 4 only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import { KeyVaultScreen } from "../KeyVaultScreen.js";

const KEY = "hf_SCREENCANARY_abcdef123456";

class FakeStdin extends EventEmitter {
	isTTY = true;
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	/** Deliver one or more chunks in a single readable event. */
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };

function makeStdout(): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = 100;
	out.rows = 30;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

/** Poll until `check` passes, so tests key off renders, not wall-clock guesses. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(10);
	}
}

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function mount() {
	const saved: [string, string][] = [];
	const stored: { name: string; last4: string; backend: "keychain" }[] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(
		<KeyVaultScreen
			targets={[{ label: "Hugging Face", vaultName: "HF_TOKEN" }]}
			onClose={() => {}}
			store={(n, v) => {
				saved.push([n, v]);
				stored.push({ name: n, last4: v.slice(-4), backend: "keychain" });
				return "keychain";
			}}
			remove={() => true}
			list={() => [...stored]}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout() as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await waitFor(() => stripAnsi(stdout.written).includes("Provider keys"), "first frame");
	const press = async (data: string, expect?: string) => {
		const mark = stdout.written.length;
		stdin.feed(data);
		if (expect) {
			await waitFor(() => stripAnsi(stdout.written.slice(mark)).includes(expect), expect);
			await tick(20);
		} else await tick(50);
	};
	return { saved, press, all: () => stripAnsi(stdout.written) };
}

describe("KeyVaultScreen", () => {
	test("typed key renders only as bullets and is saved on Enter", async () => {
		const { saved, press, all } = await mount();
		await press("\r", "Key for Hugging Face");
		await press(KEY, "\u2022".repeat(KEY.length));
		expect(all()).not.toContain(KEY);
		expect(all()).not.toContain("SCREENCANARY");
		await press("\r", "Saved key for Hugging Face");
		expect(saved).toEqual([["HF_TOKEN", KEY]]);
		// List shows the last four characters only.
		expect(all()).toContain(`****${KEY.slice(-4)}`);
		expect(all()).not.toContain(KEY);
	});

	test("a paste with its Enter in the same chunk saves once", async () => {
		const { saved, press, all } = await mount();
		await press("\r", "Key for Hugging Face");
		await press(`${KEY}\r`, "Saved key");
		expect(saved).toEqual([["HF_TOKEN", KEY]]);
		expect(all()).not.toContain(KEY);
	});

	test("Esc cancels and saves nothing", async () => {
		const { saved, press, all } = await mount();
		await press("\r", "Key for Hugging Face");
		await press("abcd");
		await press("\x1b", "Nothing saved");
		expect(saved).toEqual([]);
		expect(all()).not.toContain("abcd");
	});
});
