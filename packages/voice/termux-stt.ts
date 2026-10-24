/**
 * Cloud voice input on Android (#4833): one `termux-speech-to-text` call.
 *
 * That command (termux-api package plus the Termux:API app) starts Android's
 * SpeechRecognizer (termux-api SpeechToTextAPI.java: createSpeechRecognizer, no
 * offline preference), so the phone's own recogniser hears the audio, which can
 * be Google's service. Since #4905 the default is on the phone
 * (termux-local-stt.ts); this path runs only after /voice mic cloud and a typed
 * yes to a question that says the audio leaves the phone. Spawn is injected;
 * tests never touch a microphone.
 */

import { spawn as nodeSpawn } from "node:child_process";

export const LISTEN_TIMEOUT_MS = 30_000;

export const missingAppLine = "Voice input needs termux-api: run pkg install termux-api.";
export const noSpeechLine =
	"Heard nothing, or the Termux:API app has no microphone permission (Android Settings, Apps, Termux:API, Permissions).";
export const timeoutLine =
	"Termux:API did not answer. Install the Termux:API app from F-Droid, open it once, then try again.";

export type ListenResult = { text: string } | { error: string };

/** The part of a child process this uses. */
export interface SttChild {
	stdout: { on(ev: "data", fn: (d: unknown) => void): unknown } | null;
	on(ev: "error" | "close", fn: (arg: never) => void): unknown;
	kill(): boolean;
}

export interface ListenDeps {
	spawn?: (cmd: string, args: string[]) => SttChild;
	timeoutMs?: number;
}

/** Text from another process, safe for the prompt: control and Unicode format characters (escape codes, bidi overrides, zero-width) removed. */
function clean(s: string): string {
	return s
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/\p{Cf}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Listen once. Resolves with the last line the recogniser printed, or one line saying why not. */
export function listenOnce(deps: ListenDeps = {}): Promise<ListenResult> {
	const spawn =
		deps.spawn ??
		((cmd: string, args: string[]) =>
			nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }) as unknown as SttChild);
	const timeoutMs = deps.timeoutMs ?? LISTEN_TIMEOUT_MS;
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		let child: SttChild | undefined;
		const done = (r: ListenResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		const timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {}
			done({ error: timeoutLine });
		}, timeoutMs);
		try {
			child = spawn("termux-speech-to-text", []);
		} catch {
			return done({ error: missingAppLine });
		}
		child.stdout?.on("data", (d) => {
			out += String(d);
		});
		child.on("error", () => done({ error: missingAppLine }));
		child.on("close", () => {
			const lines = out.split("\n").map(clean).filter(Boolean);
			const text = lines.at(-1);
			done(text ? { text } : { error: noSpeechLine });
		});
	});
}
