/**
 * Canary: voice transcript text must never reach a log sink. Runs the real
 * transcribeVoice with fetch stubbed and fake ffmpeg / whisper-cli on PATH that
 * put the canary on stdout (the transcript) and on stderr (the leak risk), in
 * both the success and the failure paths, then scans console.log/warn/error/info.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocessFailure, transcribeVoice, transcriptionLogLine } from "./telegram-bridge";

const CANARY = "CANARY-purple-elephant-7731 my private dictated words";

let dir: string;
let logs: string[];
const saved: Record<string, unknown> = {};

function script(name: string, body: string) {
	const p = join(dir, "bin", name);
	writeFileSync(p, `#!/bin/sh\n${body}\n`);
	chmodSync(p, 0o755);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tg-canary-"));
	mkdirSync(join(dir, "bin"));
	mkdirSync(join(dir, "models", "whisper"), { recursive: true });
	writeFileSync(join(dir, "models", "whisper", "ggml-base.en.bin"), "x");
	saved.path = process.env.PATH;
	saved.data = process.env.EIGHT_DATA_DIR;
	saved.fetch = globalThis.fetch;
	process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
	process.env.EIGHT_DATA_DIR = dir;
	globalThis.fetch = (async (url: string) =>
		String(url).includes("getFile")
			? new Response(JSON.stringify({ ok: true, result: { file_path: "v.oga" } }))
			: new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
	logs = [];
	for (const k of ["log", "warn", "error", "info"] as const) {
		saved[k] = console[k];
		console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
	}
});

afterEach(() => {
	for (const k of ["log", "warn", "error", "info"] as const) console[k] = saved[k] as never;
	process.env.PATH = saved.path as string;
	if (saved.data === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = saved.data as string;
	globalThis.fetch = saved.fetch as typeof fetch;
	rmSync(dir, { recursive: true, force: true });
});

describe("no transcript text in logs", () => {
	test("whisper fails and echoes the canary on stderr: tail is not logged", async () => {
		script("ffmpeg", 'for a; do last=$a; done; : > "$last"');
		script("whisper-cli", `echo "${CANARY}" >&2; exit 1`);
		await transcribeVoice("tok", "fid");
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.join("\n")).not.toContain("CANARY");
	});

	test("ffmpeg fails and echoes the canary on stderr: tail is not logged", async () => {
		script("ffmpeg", `echo "${CANARY}" >&2; exit 1`);
		await transcribeVoice("tok", "fid");
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.join("\n")).not.toContain("CANARY");
	});

	test("success path: transcript returned, completion line has length and duration only", async () => {
		script("ffmpeg", 'for a; do last=$a; done; : > "$last"');
		script("whisper-cli", `echo "${CANARY}"; echo "${CANARY}" >&2`);
		const t = await transcribeVoice("tok", "fid");
		expect(t).toBe(CANARY);
		const line = transcriptionLogLine(t, 42);
		expect(line).toContain(`chars=${CANARY.length}`);
		expect(line).toContain("ms=42");
		expect(line).not.toContain("CANARY");
		expect([...logs, line].join("\n")).not.toContain("CANARY");
	});

	test("subprocessFailure keeps status and size, drops text", () => {
		const l = subprocessFailure("whisper", 1, CANARY);
		expect(l).toBe(`[telegram-bridge] whisper failed: status=1 stderr_bytes=${CANARY.length}`);
	});
});
