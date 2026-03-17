/**
 * @8gent/voice — Local Whisper Transcriber
 *
 * Transcribes audio using whisper.cpp CLI subprocess.
 * Downloads the whisper.cpp binary if not available.
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { join } from "path";
import { homedir, platform, arch } from "os";
import type { TranscriptEvent, WhisperModelName } from "./types.js";

/** Where we store the whisper.cpp binary */
const WHISPER_BIN_DIR = join(homedir(), ".8gent", "bin");
const WHISPER_BIN_NAME = "whisper-cpp";

/**
 * Get the expected path for the whisper.cpp binary.
 */
export function getWhisperBinaryPath(): string {
  return join(WHISPER_BIN_DIR, WHISPER_BIN_NAME);
}

/**
 * Check if the whisper.cpp binary is available.
 * First checks our managed binary, then checks system PATH.
 */
export async function findWhisperBinary(): Promise<string | null> {
  // Check our managed binary
  const managedPath = getWhisperBinaryPath();
  if (existsSync(managedPath)) {
    return managedPath;
  }

  // Check system PATH for common whisper.cpp binary names
  const names = ["whisper-cpp", "whisper", "main"];
  for (const name of names) {
    try {
      const proc = spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0 && output.trim()) {
        return output.trim();
      }
    } catch {
      // not found, continue
    }
  }

  // Check brew-installed whisper.cpp
  const brewPath = "/opt/homebrew/bin/whisper-cpp";
  if (existsSync(brewPath)) {
    return brewPath;
  }

  return null;
}

/**
 * Attempt to install whisper.cpp via Homebrew (macOS only).
 */
export async function installWhisperCpp(): Promise<string | null> {
  if (platform() !== "darwin") {
    return null;
  }

  try {
    // Check if brew is available
    const brewCheck = spawn(["which", "brew"], { stdout: "pipe", stderr: "pipe" });
    const brewPath = (await new Response(brewCheck.stdout).text()).trim();
    if ((await brewCheck.exited) !== 0 || !brewPath) {
      return null;
    }

    // Install whisper.cpp via brew
    const install = spawn(["brew", "install", "whisper-cpp"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await install.exited;

    // Find the installed binary
    return findWhisperBinary();
  } catch {
    return null;
  }
}

export interface TranscriberOptions {
  /** Path to the whisper.cpp binary */
  binaryPath: string;
  /** Path to the GGML model file */
  modelPath: string;
  /** Transcription language (default: "en") */
  language?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Number of processing threads (default: auto) */
  threads?: number;
}

/**
 * Transcribe a WAV file using whisper.cpp.
 *
 * @param wavPath Path to the 16kHz mono WAV file
 * @param options Transcriber configuration
 * @returns TranscriptEvent with the transcribed text
 */
export async function transcribeLocal(
  wavPath: string,
  options: TranscriberOptions,
): Promise<TranscriptEvent> {
  const {
    binaryPath,
    modelPath,
    language = "en",
    timeoutMs = 30000,
    threads,
  } = options;

  if (!existsSync(wavPath)) {
    throw new Error(`WAV file not found: ${wavPath}`);
  }
  if (!existsSync(binaryPath)) {
    throw new Error(`Whisper binary not found: ${binaryPath}`);
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const startTime = Date.now();

  // Build command arguments
  const args = [
    "-m", modelPath,         // model file
    "-f", wavPath,           // input WAV
    "-l", language,          // language
    "--no-timestamps",       // no timestamps in output
    "-nt",                   // no token timestamps
    "--print-special", "false",
  ];

  if (threads) {
    args.push("-t", String(threads));
  }

  // On Apple Silicon, use CoreML acceleration if available
  if (platform() === "darwin" && arch() === "arm64") {
    // whisper.cpp auto-detects Apple Neural Engine, no flag needed
  }

  // Spawn whisper.cpp process
  const proc = spawn([binaryPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race between process completion and timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`Transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const [stdout, stderr] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise.then(() => ["", ""] as [string, string]),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`whisper.cpp exited with code ${exitCode}: ${stderr.trim()}`);
    }

    // Parse output — whisper.cpp outputs transcribed text to stdout
    // Filter out whisper.cpp info lines (they start with "whisper_" or contain timing info)
    const lines = stdout.split("\n");
    const textLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("whisper_")) return false;
      if (trimmed.startsWith("[")) return false; // timestamp lines
      if (trimmed.startsWith("output_")) return false;
      return true;
    });

    const text = textLines.join(" ").trim();
    const durationMs = Date.now() - startTime;

    // Estimate audio duration from WAV file size
    // WAV at 16kHz, 16-bit, mono = 32000 bytes per second
    let audioDurationMs = 0;
    try {
      const file = Bun.file(wavPath);
      const wavBytes = file.size - 44; // subtract WAV header
      audioDurationMs = Math.round((wavBytes / 32000) * 1000);
    } catch {
      // ignore
    }

    return {
      text: cleanTranscript(text),
      isFinal: true,
      durationMs,
      model: extractModelName(modelPath),
      audioDurationMs,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Clean up whisper.cpp transcript output.
 * Removes artifacts, extra whitespace, and common whisper hallucinations.
 */
function cleanTranscript(text: string): string {
  let cleaned = text
    // Remove whisper.cpp artifacts
    .replace(/\[BLANK_AUDIO\]/g, "")
    .replace(/\(silence\)/g, "")
    .replace(/\[inaudible\]/g, "")
    // Remove repeated words (common whisper artifact)
    .replace(/\b(\w+)\s+\1\b/gi, "$1")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();

  // If the result is just noise/artifacts, return empty
  if (cleaned.length < 2) {
    return "";
  }

  return cleaned;
}

/**
 * Extract model name from file path.
 */
function extractModelName(modelPath: string): WhisperModelName {
  if (modelPath.includes("tiny")) return "tiny";
  if (modelPath.includes("base")) return "base";
  if (modelPath.includes("small")) return "small";
  return "tiny"; // default
}
