#!/usr/bin/env bun
/**
 * Fake Marlin sidecar — a real child process for testing the JSON-RPC
 * client and the `extract_video` handler WITHOUT the real Python sidecar
 * (#2631), which is built in parallel and is not on main.
 *
 * It speaks the exact protocol of VIDEO-INGESTION spec §4-5: newline-
 * delimited JSON-RPC 2.0 over stdin/stdout, a `ready` notification on
 * startup, and the `initialize` / `health` / `caption` / `transcribe` /
 * `find` / `shutdown` methods.
 *
 * Behaviour is driven by environment variables so one fixture covers every
 * test scenario:
 *
 *   FAKE_MODE=ok            — valid responses (default).
 *   FAKE_MODE=long          — `health` reports a >2min duration so the
 *                             handler exercises chunk-and-merge; each
 *                             `caption` returns window-relative events,
 *                             including a seam-duplicate event.
 *   FAKE_MODE=no-ready      — never emits `ready` (ready-timeout path).
 *   FAKE_MODE=crash-once    — exits after the first `caption`; a second
 *                             process instance behaves as `ok`.
 *   FAKE_MODE=rpc-error     — returns a JSON-RPC error (-33002 decode fail)
 *                             on `caption`.
 *   FAKE_MODE=no-audio      — `transcribe` reports hasAudio:false.
 *
 *   FAKE_CRASH_FLAG=<path>  — for crash-once: a file the process touches to
 *                             record that it has already run, so the next
 *                             instance behaves normally.
 */

import { existsSync, writeFileSync } from "node:fs";

const CRASH_FLAG = process.env.FAKE_CRASH_FLAG ?? "";
// crash-once: the first spawned instance crashes; once the flag file exists
// (written by that first instance), every later instance behaves as `ok`.
// This makes the handler's restart-once-and-retry path end in success.
let MODE = process.env.FAKE_MODE ?? "ok";
if (MODE === "crash-once" && CRASH_FLAG && existsSync(CRASH_FLAG)) {
	MODE = "ok";
}

function emit(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id: number, result: unknown): void {
	emit({ jsonrpc: "2.0", id, result });
}

function replyError(id: number, code: number, message: string, data?: unknown): void {
	emit({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

// no-ready mode: stay silent forever (the client's ready timeout fires).
if (MODE === "no-ready") {
	// Keep the process alive with no output.
	setInterval(() => {}, 1 << 30);
} else {
	// Ready handshake (spec §4.3 step 2).
	emit({ jsonrpc: "2.0", method: "ready", params: { pid: process.pid } });
}

let captionCalls = 0;

function handle(line: string): void {
	let msg: { id?: number; method?: string; params?: Record<string, unknown> };
	try {
		msg = JSON.parse(line);
	} catch {
		emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	const id = msg.id ?? 0;
	const method = msg.method ?? "";

	switch (method) {
		case "initialize":
			reply(id, {
				ready: true,
				device: "cpu",
				mpsFallback: false,
				models: { vision: "NemoStation/Marlin-2B@deadbeef", audio: "whisper-base-mlx" },
				loadMs: 10,
				warnings: [],
			});
			return;

		case "health":
			reply(id, {
				status: "ok",
				uptimeSec: 1,
				rssMb: 100,
				device: "cpu",
				queueDepth: 0,
				// `long` mode forces chunk-and-merge: 250s => 3 windows at 120s.
				durationSec: MODE === "long" ? 250 : 96.4,
			});
			return;

		case "caption": {
			captionCalls++;
			if (MODE === "crash-once" && captionCalls === 1) {
				// Record that we have crashed once, then die hard.
				if (CRASH_FLAG && !existsSync(CRASH_FLAG)) {
					writeFileSync(CRASH_FLAG, "crashed");
				}
				process.stderr.write("fake sidecar: simulated crash on first caption\n");
				process.exit(1);
			}
			if (MODE === "rpc-error") {
				replyError(id, -33002, "Video decode failed", { decoder: "torchcodec" });
				return;
			}
			const startSec = (msg.params?.startSec as number) ?? 0;
			if (MODE === "long") {
				// Window-relative events. The event at the END of each window
				// ("scene transition near the boundary", 118-120s) and the
				// event at the START of the next window (same description,
				// 0-2s) form a real seam duplicate the handler must merge.
				reply(id, {
					scene: `Window starting at ${startSec}s of the demo.`,
					events: [
						{ start: 0.0, end: 2.0, description: "scene transition near the boundary" },
						{ start: 5.0, end: 9.0, description: "a developer types a command" },
						{ start: 118.0, end: 120.0, description: "scene transition near the boundary" },
					],
					frameCount: 240,
					truncated: false,
				});
				return;
			}
			reply(id, {
				scene: "A developer demonstrates the 8gent plan rail in a terminal UI.",
				events: [
					{ start: 0.0, end: 4.2, description: "the terminal opens and a prompt is typed" },
					{ start: 4.2, end: 11.8, description: "an agent plan renders as a checklist" },
				],
				frameCount: 142,
				truncated: false,
			});
			return;
		}

		case "transcribe":
			if (MODE === "no-audio") {
				reply(id, { language: "en", transcript: [], hasAudio: false });
				return;
			}
			reply(id, {
				language: "en",
				transcript: [
					{ start: 0.6, end: 3.1, text: "Let me show you the plan rail." },
					{ start: 3.4, end: 7.9, text: "Each step is a task with a status." },
				],
				hasAudio: true,
			});
			return;

		case "find":
			reply(id, { span: { start: 14.3, end: 18.2 }, formatOk: true });
			return;

		case "shutdown":
			reply(id, { stopped: true });
			setTimeout(() => process.exit(0), 5);
			return;

		default:
			replyError(id, -32601, `Method not found: ${method}`);
			return;
	}
}

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
	buf += chunk;
	for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (line.length > 0) handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));
