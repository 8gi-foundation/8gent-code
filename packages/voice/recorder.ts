/**
 * @8gent/voice — Mic Recorder
 *
 * Records audio via `sox`/`rec` subprocess. Outputs 16kHz mono WAV
 * (the format Whisper expects). Emits audio level events.
 */

import { spawn, type Subprocess } from "bun";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync, statSync } from "fs";
import { EventEmitter } from "events";

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

export interface RecorderEvents {
  start: [];
  stop: [{ path: string; durationMs: number }];
  "audio-level": [{ level: number }];
  error: [{ message: string }];
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
    installHint: process.platform === "darwin"
      ? "Install with: brew install sox"
      : process.platform === "linux"
        ? "Install with: sudo apt install sox (Debian/Ubuntu) or sudo dnf install sox (Fedora)"
        : "Install SoX from https://sox.sourceforge.net/",
  };
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
  private startTime: number = 0;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private isRecording: boolean = false;
  private options: Required<RecorderOptions>;

  constructor(opts: RecorderOptions = {}) {
    super();
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

    const soxCheck = await checkSoxInstalled();
    if (!soxCheck.installed) {
      this.emit("error", { message: `sox/rec not found. ${soxCheck.installHint}` });
      throw new Error(`sox not installed. ${soxCheck.installHint}`);
    }

    // Generate a fresh temp path for this recording
    this.outputPath = this.options.outputPath.includes("8gent-voice-")
      ? join(tmpdir(), `8gent-voice-${Date.now()}.wav`)
      : this.options.outputPath;

    // Build rec command arguments
    // rec -q -r 16000 -c 1 -b 16 -t wav output.wav
    const args = [
      "-q",                                    // quiet (no progress)
      "-r", String(this.options.sampleRate),   // sample rate
      "-c", String(this.options.channels),     // channels
      "-b", String(this.options.bitDepth),     // bit depth
      "-t", "wav",                             // output format
      this.outputPath,                          // output file
    ];

    try {
      this.process = spawn(["rec", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      this.isRecording = true;
      this.startTime = Date.now();
      this.emit("start");

      // Simulate audio levels (sox rec doesn't output levels in quiet mode)
      // In a real implementation, we'd use sox's --show-progress or stat effect
      this.levelInterval = setInterval(() => {
        if (this.isRecording) {
          // Generate a pseudo-level based on file size growth
          // This gives a rough indication that audio is being captured
          try {
            if (existsSync(this.outputPath)) {
              const stat = statSync(this.outputPath);
              const bytesPerSecond = this.options.sampleRate * this.options.channels * (this.options.bitDepth / 8);
              const expectedBytes = ((Date.now() - this.startTime) / 1000) * bytesPerSecond;
              const ratio = expectedBytes > 0 ? Math.min(stat.size / expectedBytes, 1) : 0;
              // Add some randomness to simulate real audio levels
              const level = Math.max(0, Math.min(1, ratio * 0.5 + Math.random() * 0.3));
              this.emit("audio-level", { level });
            }
          } catch {
            // File might not exist yet, ignore
          }
        }
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
          this.emit("error", { message: `rec process exited with code ${code}` });
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

    // Kill the rec process (sends SIGTERM which makes it finalize the WAV header)
    try {
      this.process.kill("SIGTERM");
      // Wait for process to exit cleanly
      await Promise.race([
        this.process.exited,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Force kill if SIGTERM didn't work
      try {
        this.process.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }

    this.isRecording = false;
    this.cleanup();

    const result = { path: this.outputPath, durationMs };
    this.emit("stop", result);
    return result;
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
