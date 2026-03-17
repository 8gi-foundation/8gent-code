/**
 * @8gent/voice — Voice Activity Detection
 *
 * Energy-based VAD that detects speech start/stop from audio level events.
 * Used for auto-start/stop recording without requiring a hold-to-speak key.
 */

export interface VADOptions {
  /** Energy threshold for speech detection (0-1, default: 0.15) */
  energyThreshold?: number;
  /** Duration of silence before stopping (ms, default: 1500) */
  silenceDurationMs?: number;
  /** Minimum speech duration to consider valid (ms, default: 300) */
  minSpeechDurationMs?: number;
  /** Smoothing factor for energy levels (0-1, default: 0.3) */
  smoothingFactor?: number;
}

export type VADState = "idle" | "listening" | "speech-detected" | "silence-timeout";

export interface VADEvents {
  "speech-start": [];
  "speech-end": [{ durationMs: number }];
  "state-change": [{ from: VADState; to: VADState }];
}

/**
 * Voice Activity Detector based on audio energy levels.
 *
 * Feed it audio level values (0-1), and it emits speech-start/speech-end events.
 *
 * Usage:
 * ```ts
 * const vad = new VoiceActivityDetector({ silenceDurationMs: 1500 });
 * vad.on('speech-start', () => recorder.start());
 * vad.on('speech-end', () => recorder.stop());
 * vad.start();
 *
 * // Feed audio levels from recorder
 * recorder.on('audio-level', ({ level }) => vad.processLevel(level));
 * ```
 */
export class VoiceActivityDetector {
  private options: Required<VADOptions>;
  private state: VADState = "idle";
  private smoothedLevel: number = 0;
  private speechStartTime: number = 0;
  private lastSpeechTime: number = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  constructor(opts: VADOptions = {}) {
    this.options = {
      energyThreshold: opts.energyThreshold ?? 0.15,
      silenceDurationMs: opts.silenceDurationMs ?? 1500,
      minSpeechDurationMs: opts.minSpeechDurationMs ?? 300,
      smoothingFactor: opts.smoothingFactor ?? 0.3,
    };
  }

  /**
   * Register an event listener.
   */
  on<K extends keyof VADEvents>(event: K, callback: (...args: VADEvents[K]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(callback);
    this.listeners.set(event, existing);
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof VADEvents>(event: K, callback: (...args: VADEvents[K]) => void): void {
    const existing = this.listeners.get(event) || [];
    this.listeners.set(event, existing.filter((cb) => cb !== callback));
  }

  private emit<K extends keyof VADEvents>(event: K, ...args: VADEvents[K]): void {
    const callbacks = this.listeners.get(event) || [];
    for (const cb of callbacks) {
      cb(...args);
    }
  }

  /**
   * Start listening for voice activity.
   */
  start(): void {
    this.setState("listening");
    this.smoothedLevel = 0;
  }

  /**
   * Stop listening.
   */
  stop(): void {
    this.clearSilenceTimer();
    if (this.state === "speech-detected") {
      const durationMs = Date.now() - this.speechStartTime;
      this.emit("speech-end", { durationMs });
    }
    this.setState("idle");
  }

  /**
   * Process an audio level sample (0-1).
   * Call this repeatedly with audio level values from the recorder.
   */
  processLevel(level: number): void {
    if (this.state === "idle") return;

    // Exponential smoothing to reduce noise
    this.smoothedLevel =
      this.options.smoothingFactor * level +
      (1 - this.options.smoothingFactor) * this.smoothedLevel;

    const isSpeech = this.smoothedLevel >= this.options.energyThreshold;

    if (isSpeech) {
      this.lastSpeechTime = Date.now();

      if (this.state === "listening" || this.state === "silence-timeout") {
        // Speech started
        this.clearSilenceTimer();
        this.speechStartTime = Date.now();
        this.setState("speech-detected");
        this.emit("speech-start");
      }
    } else if (this.state === "speech-detected") {
      // Currently in speech, but level dropped — start silence timer
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          const durationMs = Date.now() - this.speechStartTime;

          if (durationMs >= this.options.minSpeechDurationMs) {
            this.emit("speech-end", { durationMs });
            this.setState("listening");
          } else {
            // Too short, ignore (noise)
            this.setState("listening");
          }
        }, this.options.silenceDurationMs);

        this.setState("silence-timeout");
      }
    }
  }

  /**
   * Get current VAD state.
   */
  getState(): VADState {
    return this.state;
  }

  /**
   * Get the current smoothed audio level.
   */
  getSmoothedLevel(): number {
    return this.smoothedLevel;
  }

  /**
   * Update options at runtime.
   */
  updateOptions(opts: Partial<VADOptions>): void {
    if (opts.energyThreshold !== undefined) this.options.energyThreshold = opts.energyThreshold;
    if (opts.silenceDurationMs !== undefined) this.options.silenceDurationMs = opts.silenceDurationMs;
    if (opts.minSpeechDurationMs !== undefined) this.options.minSpeechDurationMs = opts.minSpeechDurationMs;
    if (opts.smoothingFactor !== undefined) this.options.smoothingFactor = opts.smoothingFactor;
  }

  private setState(newState: VADState): void {
    if (this.state === newState) return;
    const from = this.state;
    this.state = newState;
    this.emit("state-change", { from, to: newState });
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
