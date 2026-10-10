/**
 * @8gent/voice — Mic Recorder
 *
 * Records audio via `sox`/`rec` subprocess. Outputs 16kHz mono WAV
 * (the format Whisper expects). Emits audio level events.
 */

import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { type InputDevice, resolveInputDevice } from "./input-device.js";

export interface RecorderOptions {
	/** Sample rate in Hz (default: 16000 for Whisper) */
	sampleRate?: number;
	/** Number of channels (default: 1 = mono) */
	channels?: number;
	/** Bit depth (default: 16) */
	bitDepth?: number;
	/** Max recording duration in seconds */
	maxDurationSeconds?: number;
	/** Output file path (default: temp file) */
	outputPath?: string;
}

/** Injection points for tests; production uses the defaults. */
export interface RecorderDeps {
	resolveDevice?: () => Promise<InputDevice>;
	checkSox?: () => Promise<{ installed: boolean; installHint: string }>;
	spawnRec?: (args: string[]) => Subprocess;
	/** Wait this long after SIGTERM before escalating to SIGKILL (default 1500) */
	killGraceMs?: number;
}

export interface RecorderEvents {
	start: [];
	stop: [{ path: string; durationMs: number }];
	"audio-level": [{ level: number }];
	error: [{ message: string }];
	/** Emitted at the start of every recording with the current default input */
	device: [InputDevice];
}

/**
 * Check if sox/rec is installed and return its path.
 */
export async function findSoxPath(): Promise<string | null> {
	try {
		const proc = spawn(["which", "rec"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode === 0 && output.trim()) {
			return output.trim();
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Check if sox is installed. Returns install instructions if not.
 */
export async function checkSoxInstalled(): Promise<{
	installed: boolean;
	path: string | null;
	installHint: string;
}> {
	const path = await findSoxPath();
	return {
		installed: path !== null,
		path,
		installHint:
			process.platform === "darwin"
				? "Install with: brew install sox"
				: process.platform === "linux"
					? "Install with: sudo apt install sox (Debian/Ubuntu) or sudo dnf install sox (Fedora)"
					: "Install SoX from https://sox.sourceforge.net/",
	};
}

/**
 * RMS level (0-1) of the last ~100 ms of 16-bit PCM in a growing WAV file.
 * sox flushes in blocks, so this is real but updates in steps. Returns null
 * when the file has no audio data yet or the format is not 16-bit.
 */
export function readTailLevel(path: string, bitDepth = 16, windowBytes = 3200): number | null {
	if (bitDepth !== 16) return null;
	try {
		const size = statSync(path).size;
		if (size <= 44 + 2) return null;
		const len = Math.min(windowBytes, size - 44) & ~1;
		const buf = Buffer.alloc(len);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buf, 0, len, size - len);
		} finally {
			closeSync(fd);
		}
		return pcm16Level(buf);
	} catch {
		return null;
	}
}

/** RMS of little-endian 16-bit samples, scaled so ordinary speech reads mid-bar. */
export function pcm16Level(buf: Uint8Array): number {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const n = Math.floor(buf.byteLength / 2);
	if (n === 0) return 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const v = view.getInt16(i * 2, true) / 32768;
		sum += v * v;
	}
	return Math.min(1, Math.sqrt(sum / n) * 4);
}

/**
 * Microphone recorder using sox `rec` command.
 *
 * Usage:
 * ```ts
 * const recorder = new MicRecorder();
 * recorder.on('audio-level', ({ level }) => console.log(level));
 * const wavPath = await recorder.start();
 * // ... user speaks ...
 * const result = await recorder.stop();
 * // result.path contains the WAV file
 * ```
 */
export class MicRecorder extends EventEmitter<RecorderEvents> {
	private process: Subprocess | null = null;
	private outputPath: string;
	private startTime = 0;
	private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
	private levelInterval: ReturnType<typeof setInterval> | null = null;
	private isRecording = false;
	private options: Required<RecorderOptions>;
	private device: InputDevice | null = null;
	private deps: RecorderDeps;

	constructor(opts: RecorderOptions = {}, deps: RecorderDeps = {}) {
		super();
		this.deps = deps;
		this.options = {
			sampleRate: opts.sampleRate ?? 16000,
			channels: opts.channels ?? 1,
			bitDepth: opts.bitDepth ?? 16,
			maxDurationSeconds: opts.maxDurationSeconds ?? 30,
			outputPath: opts.outputPath ?? join(tmpdir(), `8gent-voice-${Date.now()}.wav`),
		};
		this.outputPath = this.options.outputPath;
	}

	/**
	 * Start recording from the microphone.
	 * Returns the path where the WAV file will be written.
	 */
	async start(): Promise<string> {
		if (this.isRecording) {
			throw new Error("Already recording");
		}

		const soxCheck = await (this.deps.checkSox ?? checkSoxInstalled)();
		if (!soxCheck.installed) {
			this.emit("error", {
				message: `sox/rec not found. ${soxCheck.installHint}`,
			});
			throw new Error(`sox not installed. ${soxCheck.installHint}`);
		}

		// The device name is display-only and is resolved in parallel below, so
		// the lookup can never delay the start of recording.
		this.device = null;

		// Generate a fresh temp path for this recording
		this.outputPath = this.options.outputPath.includes("8gent-voice-")
			? join(tmpdir(), `8gent-voice-${Date.now()}.wav`)
			: this.options.outputPath;

		// Build rec command arguments
		// rec -q -r 16000 -c 1 -b 16 -t wav output.wav
		const args = [
			"-q", // quiet (no progress)
			"-r",
			String(this.options.sampleRate), // sample rate
			"-c",
			String(this.options.channels), // channels
			"-b",
			String(this.options.bitDepth), // bit depth
			"-t",
			"wav", // output format
			this.outputPath, // output file
		];

		try {
			this.process = this.deps.spawnRec
				? this.deps.spawnRec(args)
				: spawn(["rec", ...args], { stdout: "ignore", stderr: "ignore" });

			this.isRecording = true;
			this.startTime = Date.now();
			this.emit("start");

			// Resolve on EVERY start, never cached, so a headset or AirPods switch
			// applies on the next press. sox records from the OS default input.
			const startedAt = this.startTime;
			(this.deps.resolveDevice ?? resolveInputDevice)()
				.then((d) => {
					if (this.startTime !== startedAt) return; // a newer recording owns the slot
					this.device = d;
					this.emit("device", d);
				})
				.catch(() => {});

			// Real levels: RMS of the newest PCM samples sox has written to the file.
			this.levelInterval = setInterval(() => {
				if (!this.isRecording) return;
				const level = readTailLevel(this.outputPath, this.options.bitDepth);
				if (level !== null) this.emit("audio-level", { level });
			}, 100);

			// Safety: max recording duration
			this.maxDurationTimer = setTimeout(() => {
				if (this.isRecording) {
					this.stop().catch(() => {});
				}
			}, this.options.maxDurationSeconds * 1000);

			// Handle process exit (unexpected)
			this.process.exited.then((code) => {
				if (this.isRecording && code !== 0 && code !== null) {
					this.isRecording = false;
					this.cleanup();
					this.emit("error", {
						message: `rec process exited with code ${code}`,
					});
				}
			});
		} catch (err) {
			this.isRecording = false;
			const message = err instanceof Error ? err.message : "Failed to start recording";
			this.emit("error", { message });
			throw err;
		}

		return this.outputPath;
	}

	/**
	 * Stop recording and return the WAV file path with duration.
	 */
	async stop(): Promise<{ path: string; durationMs: number }> {
		if (!this.isRecording || !this.process) {
			throw new Error("Not recording");
		}

		const durationMs = Date.now() - this.startTime;

		// SIGTERM lets sox finalize the WAV header; escalate to SIGKILL if it
		// has not exited after a short grace period.
		const proc = this.process;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			proc.kill("SIGTERM");
			const exited = await Promise.race([
				proc.exited.then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), this.deps.killGraceMs ?? 1500);
				}),
			]);
			if (!exited) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// Already dead
				}
			}
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already dead
			}
		} finally {
			if (timer) clearTimeout(timer);
		}

		this.isRecording = false;
		this.cleanup();

		const result = { path: this.outputPath, durationMs };
		this.emit("stop", result);
		return result;
	}

	/**
	 * The input device for the current recording, or null until the lookup lands.
	 */
	getDevice(): InputDevice | null {
		return this.device;
	}

	/**
	 * Check if currently recording.
	 */
	getIsRecording(): boolean {
		return this.isRecording;
	}

	/**
	 * Get current recording duration in ms.
	 */
	getDurationMs(): number {
		if (!this.isRecording) return 0;
		return Date.now() - this.startTime;
	}

	/**
	 * Get the output file path.
	 */
	getOutputPath(): string {
		return this.outputPath;
	}

	/**
	 * Clean up a WAV file after transcription.
	 */
	static cleanupFile(path: string): void {
		try {
			if (existsSync(path)) {
				unlinkSync(path);
			}
		} catch {
			// Best effort cleanup
		}
	}

	private cleanup(): void {
		if (this.maxDurationTimer) {
			clearTimeout(this.maxDurationTimer);
			this.maxDurationTimer = null;
		}
		if (this.levelInterval) {
			clearInterval(this.levelInterval);
			this.levelInterval = null;
		}
		this.process = null;
	}
}
