/**
 * @8gent/voice — Voice Chat Loop
 *
 * Half-duplex voice conversation: Listen -> Transcribe -> Agent -> Speak -> Listen.
 * Uses sox's built-in silence detection to auto-stop recording when you stop talking.
 * Supports interrupt (kill TTS mid-speech via ESC).
 *
 * Usage:
 * ```ts
 * const chat = new VoiceChatLoop({ engine, onMessage, voice: "Daniel" });
 * await chat.start();
 * // ... runs until chat.stop() or error
 * ```
 */

import { VoiceEngine } from "./index.js";
import type { TranscriptEvent } from "./types.js";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

// ============================================
// Types
// ============================================

export type VoiceChatState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "stopping";

export interface VoiceChatConfig {
  /** VoiceEngine instance (STT) */
  engine: VoiceEngine;
  /** Callback when user transcript is ready — return agent response text */
  onMessage: (transcript: string) => Promise<string>;
  /** macOS voice name for TTS (default: Daniel) */
  voice?: string;
  /** Speech rate in words per minute (default: 200) */
  rate?: number;
  /** Silence duration before auto-stop recording (ms, default: 1500) */
  silenceMs?: number;
  /** Callback for state changes (for UI updates) */
  onStateChange?: (state: VoiceChatState, detail?: string) => void;
  /** Callback for errors */
  onError?: (error: string) => void;
  /** Max TTS text length (default: 500 chars) */
  maxSpeakLength?: number;
}

export interface VoiceChatEvents {
  "state-change": [VoiceChatState, string?];
  "user-said": [string];
  "agent-said": [string];
  "error": [string];
  "stopped": [];
}

// ============================================
// Voice Chat Loop
// ============================================

export class VoiceChatLoop {
  private engine: VoiceEngine;
  private onMessage: (transcript: string) => Promise<string>;
  private voice: string;
  private rate: number;
  private silenceMs: number;
  private maxSpeakLength: number;
  private onStateChange?: (state: VoiceChatState, detail?: string) => void;
  private onError?: (error: string) => void;

  private state: VoiceChatState = "idle";
  private running = false;
  private ttsProcess: { kill: () => void; exited: Promise<number> } | null = null;
  private recProcess: { kill: () => void; exited: Promise<number> } | null = null;
  private listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  constructor(config: VoiceChatConfig) {
    this.engine = config.engine;
    this.onMessage = config.onMessage;
    this.voice = config.voice ?? "Daniel";
    this.rate = config.rate ?? 200;
    this.silenceMs = config.silenceMs ?? 1500;
    this.maxSpeakLength = config.maxSpeakLength ?? 500;
    this.onStateChange = config.onStateChange;
    this.onError = config.onError;
  }

  // ---- Public API ----

  getState(): VoiceChatState {
    return this.state;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the voice chat loop. Runs until stop() is called.
   * Uses non-blocking scheduling to avoid starving the React event loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setState("listening");

    // We use sox's built-in silence detection instead of VAD
    // (VoiceEngine's audio levels are simulated, not real)

    // Non-blocking loop — yield to event loop between turns
    const scheduleNextTurn = async () => {
      if (!this.running) {
        this.setState("idle");
        this.emit("stopped");
        return;
      }

      try {
        await this.runOneTurn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onError?.(msg);
        this.emit("error", msg);
        if (this.running) await sleep(1000);
      }

      // Yield to event loop before scheduling next turn
      if (this.running) {
        setTimeout(scheduleNextTurn, 50);
      } else {
        this.setState("idle");
        this.emit("stopped");
      }
    };

    // Start first turn after yielding to let React finish rendering
    setTimeout(scheduleNextTurn, 100);
  }

  /**
   * Stop the voice chat loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.setState("stopping");

    // Kill any in-flight TTS or recording
    await this.killTTS();
    this.killRecording();
  }

  private killRecording(): void {
    if (this.recProcess) {
      try { this.recProcess.kill(); } catch {}
      this.recProcess = null;
    }
  }

  /**
   * Interrupt the agent mid-speech and go back to listening.
   */
  async interrupt(): Promise<void> {
    await this.killTTS();
    // Loop will continue to next turn (listening)
  }

  // ---- Event emitter (minimal) ----

  on<K extends keyof VoiceChatEvents>(
    event: K,
    listener: (...args: VoiceChatEvents[K]) => void
  ): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, existing);
    return this;
  }

  private emit<K extends keyof VoiceChatEvents>(event: K, ...args: VoiceChatEvents[K]): void {
    const fns = this.listeners.get(event);
    if (fns) for (const fn of fns) fn(...args);
  }

  // ---- Internal ----

  private setState(state: VoiceChatState, detail?: string): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      this.onStateChange?.(state, detail);
      this.emit("state-change", state, detail);
    }
  }

  /**
   * Run one turn of the voice conversation:
   * 1. Listen (record until VAD silence)
   * 2. Transcribe
   * 3. Send to agent
   * 4. Speak response
   */
  private async runOneTurn(): Promise<void> {
    if (!this.running) return;

    // 1. LISTEN — start recording, wait for VAD to auto-stop
    this.setState("listening");
    const transcript = await this.listenForSpeech();
    if (!transcript || !this.running) return;

    this.emit("user-said", transcript);

    // 2. THINK — send to agent, wait for response
    this.setState("thinking", transcript);
    const response = await this.onMessage(transcript);
    if (!response || !this.running) return;

    this.emit("agent-said", response);

    // 3. SPEAK — play TTS, can be interrupted
    this.setState("speaking");
    await this.speakText(response);
  }

  /**
   * Record audio using sox with built-in silence detection, then transcribe.
   * Sox auto-stops when it detects silence after speech.
   * Returns transcript text, or null if empty/cancelled.
   */
  private async listenForSpeech(): Promise<string | null> {
    const wavPath = join(tmpdir(), `8gent-voicechat-${Date.now()}.wav`);
    const silenceSec = (this.silenceMs / 1000).toFixed(1);

    try {
      // Use sox rec with silence detection:
      //   silence 1 0.1 3%  → wait for speech to begin (above 3% for 0.1s)
      //   1 <silenceSec> 3% → stop after <silenceSec> seconds of silence
      this.recProcess = Bun.spawn([
        "rec", "-q",
        "-r", "16000", "-c", "1", "-b", "16",
        "-t", "wav", wavPath,
        "silence", "1", "0.1", "3%",
        "1", silenceSec, "3%",
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });

      // Wait for sox to finish (it auto-stops on silence) or timeout
      const exitCode = await Promise.race([
        this.recProcess.exited,
        sleep(30_000).then(() => {
          // Timeout — force stop
          try { this.recProcess?.kill(); } catch {}
          return -1;
        }),
      ]);

      this.recProcess = null;

      // Check if recording was cancelled
      if (!this.running) {
        cleanupFile(wavPath);
        return null;
      }

      // Check if file exists and has content
      if (!existsSync(wavPath)) {
        this.onError?.("No audio recorded");
        return null;
      }

      // Transcribe the recorded audio
      this.setState("transcribing");
      const result = await this.transcribeFile(wavPath);
      cleanupFile(wavPath);

      return result;
    } catch (err) {
      this.recProcess = null;
      cleanupFile(wavPath);
      const msg = err instanceof Error ? err.message : String(err);
      this.onError?.(`Recording error: ${msg}`);
      return null;
    }
  }

  /**
   * Transcribe a WAV file using the VoiceEngine's transcription pipeline.
   * Tries local whisper.cpp first, falls back to cloud.
   */
  private async transcribeFile(wavPath: string): Promise<string | null> {
    try {
      // Import transcription functions directly
      const { transcribeLocal, findWhisperBinary } = await import("./transcriber.js");
      const { WhisperModelManager } = await import("./model-manager.js");

      const binaryPath = await findWhisperBinary();
      if (!binaryPath) {
        // Try cloud fallback
        const { transcribeCloud, isCloudAvailable } = await import("./cloud-transcriber.js");
        if (isCloudAvailable()) {
          const result = await transcribeCloud(wavPath, { language: "en" });
          if (result?.text) {
            this.engine.emit("final-transcript", result);
            return result.text.trim() || null;
          }
        }
        this.onError?.("No whisper binary found. Install: brew install whisper-cpp");
        return null;
      }

      // Get model path
      const config = this.engine.getConfig();
      const modelManager = new WhisperModelManager(config.modelsPath);
      const modelName = config.model || "tiny";

      if (!modelManager.isModelDownloaded(modelName)) {
        this.onError?.(`Downloading whisper ${modelName} model...`);
        await modelManager.downloadModel(modelName);
      }

      const modelPath = modelManager.getModelPath(modelName);
      const result = await transcribeLocal(wavPath, {
        binaryPath,
        modelPath,
        language: "en",
        timeoutMs: 30000,
      });

      if (result?.text) {
        this.engine.emit("final-transcript", result);
        return result.text.trim() || null;
      }

      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError?.(`Transcription error: ${msg}`);
      return null;
    }
  }

  /**
   * Speak text using macOS `say` command (non-blocking, killable).
   * Splits long text into sentences for more natural delivery.
   */
  private async speakText(text: string): Promise<void> {
    // Clean and truncate
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/[*_~`#]/g, "")
      .replace(/\bhttps?:\/\/\S+/g, " link ")
      .replace(/\n+/g, ". ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, this.maxSpeakLength);

    if (!clean) return;

    // Split into sentence chunks for more responsive delivery
    const chunks = splitIntoSentences(clean);

    for (const chunk of chunks) {
      if (!this.running) break;

      const safe = chunk.replace(/"/g, '\\"');
      try {
        this.ttsProcess = Bun.spawn(["say", "-v", this.voice, "-r", String(this.rate), safe]);
        await this.ttsProcess.exited;
        this.ttsProcess = null;
      } catch {
        // Process was killed (interrupt) — that's fine
        this.ttsProcess = null;
        break;
      }
    }
  }

  /**
   * Kill any in-flight TTS process.
   */
  private async killTTS(): Promise<void> {
    if (this.ttsProcess) {
      try {
        this.ttsProcess.kill();
        await this.ttsProcess.exited;
      } catch {}
      this.ttsProcess = null;
    }
    // Also kill any stray say processes from this session
    try {
      Bun.spawnSync(["killall", "say"]);
    } catch {}
  }
}

// ============================================
// Utilities
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

/**
 * Split text into sentence-like chunks for chunked TTS delivery.
 */
function splitIntoSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const part of raw) {
    if ((current + " " + part).length > 120 && current) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += (current ? " " : "") + part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}
