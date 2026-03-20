/**
 * @8gent/voice — Voice Chat Loop
 *
 * Half-duplex voice conversation: Listen -> Transcribe -> Agent -> Speak -> Listen.
 * Uses VAD for auto-stop on silence. Supports interrupt (kill TTS mid-speech).
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
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setState("listening");

    // Enable VAD for auto-stop
    this.engine.updateConfig({
      vadEnabled: true,
      vadSilenceMs: this.silenceMs,
    });

    while (this.running) {
      try {
        await this.runOneTurn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onError?.(msg);
        this.emit("error", msg);
        // Brief pause before retrying
        if (this.running) await sleep(1000);
      }
    }

    this.setState("idle");
    this.emit("stopped");
  }

  /**
   * Stop the voice chat loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.setState("stopping");

    // Kill any in-flight TTS
    await this.killTTS();

    // Stop recording if active
    if (this.engine.isRecording()) {
      try { await this.engine.stopRecording(); } catch {}
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
   * Record audio and transcribe. Uses VAD for auto-stop.
   * Returns transcript text, or null if empty/cancelled.
   */
  private async listenForSpeech(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let resolved = false;

      const onTranscript = (event: TranscriptEvent) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        const text = event.text.trim();
        resolve(text || null);
      };

      const onError = (err: { code: string; message: string }) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        this.onError?.(`STT error: ${err.message}`);
        resolve(null);
      };

      const cleanup = () => {
        this.engine.removeListener("final-transcript", onTranscript);
        this.engine.removeListener("error", onError);
      };

      this.engine.on("final-transcript", onTranscript);
      this.engine.on("error", onError);

      // Start recording — VAD will auto-stop on silence
      this.engine.startRecording().catch((err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      });

      // Safety timeout: 30 seconds max
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (this.engine.isRecording()) {
            this.engine.stopRecording().catch(() => {});
          }
          resolve(null);
        }
      }, 30_000);
    });
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
