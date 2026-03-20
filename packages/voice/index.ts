/**
 * @8gent/voice — Voice Input Engine
 *
 * Unified public API for Speech-to-Text in 8gent Code.
 * Supports local Whisper transcription (whisper.cpp) and OpenAI cloud fallback.
 *
 * Usage:
 * ```ts
 * import { VoiceEngine } from "@8gent/voice";
 *
 * const engine = new VoiceEngine({ model: "tiny" });
 *
 * engine.on("final-transcript", (event) => {
 *   console.log("You said:", event.text);
 * });
 *
 * if (await engine.isAvailable()) {
 *   await engine.startRecording();
 *   // ... user speaks ...
 *   await engine.stopRecording(); // triggers transcription
 * }
 * ```
 */

import { EventEmitter } from "events";
import { MicRecorder, checkSoxInstalled } from "./recorder.js";
import { WhisperModelManager } from "./model-manager.js";
import { transcribeLocal, findWhisperBinary } from "./transcriber.js";
import { transcribeCloud, isCloudAvailable, getApiKey } from "./cloud-transcriber.js";
import { VoiceActivityDetector } from "./vad.js";
import {
  DEFAULT_VOICE_CONFIG,
  type VoiceConfig,
  type VoiceEventMap,
  type RecordingState,
  type TranscriptEvent,
  type DependencyCheckResult,
  type WhisperModelName,
  type VoiceErrorCode,
} from "./types.js";

// Re-export types and utilities
export * from "./types.js";
export { WhisperModelManager } from "./model-manager.js";
export { MicRecorder, checkSoxInstalled } from "./recorder.js";
export { findWhisperBinary, transcribeLocal } from "./transcriber.js";
export { transcribeCloud, isCloudAvailable } from "./cloud-transcriber.js";
export { VoiceActivityDetector } from "./vad.js";
export { VoiceChatLoop, type VoiceChatState, type VoiceChatConfig } from "./voice-chat.js";

/**
 * Main Voice Engine — orchestrates recording, transcription, and events.
 */
export class VoiceEngine extends EventEmitter<VoiceEventMap> {
  private config: VoiceConfig;
  private recorder: MicRecorder | null = null;
  private modelManager: WhisperModelManager;
  private vad: VoiceActivityDetector | null = null;
  private state: RecordingState = "idle";
  private whisperBinaryPath: string | null = null;
  private dependencyCache: DependencyCheckResult | null = null;

  constructor(config: Partial<VoiceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_VOICE_CONFIG, ...config };
    this.modelManager = new WhisperModelManager(this.config.modelsPath);

    // Forward model manager events
    this.modelManager.on("download-progress", (event) => {
      this.emit("model-download-progress", event);
    });
    this.modelManager.on("download-complete", (event) => {
      this.emit("model-download-complete", event);
    });
  }

  // ============================================
  // State Management
  // ============================================

  private setState(newState: RecordingState): void {
    if (this.state === newState) return;
    const from = this.state;
    this.state = newState;
    this.emit("state-change", { from, to: newState });
  }

  /**
   * Get current recording state.
   */
  getState(): RecordingState {
    return this.state;
  }

  /**
   * Check if currently recording.
   */
  isRecording(): boolean {
    return this.state === "recording";
  }

  /**
   * Check if currently transcribing.
   */
  isTranscribing(): boolean {
    return this.state === "transcribing";
  }

  /**
   * Check if voice is enabled in config.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ============================================
  // Dependency Checking
  // ============================================

  /**
   * Check all dependencies and return detailed status.
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    if (this.dependencyCache) return this.dependencyCache;

    const soxCheck = await checkSoxInstalled();
    const whisperBinary = await findWhisperBinary();
    const downloadedModels = this.modelManager.getDownloadedModels();

    // Simple mic check — if sox is installed, mic is likely available
    // Real mic check happens when recording starts
    const micAvailable = soxCheck.installed;

    this.whisperBinaryPath = whisperBinary;

    this.dependencyCache = {
      soxInstalled: soxCheck.installed,
      soxPath: soxCheck.path,
      whisperBinaryPath: whisperBinary,
      modelsDir: this.modelManager.getModelsDir(),
      downloadedModels,
      micAvailable,
    };

    return this.dependencyCache;
  }

  /**
   * Check if voice input can work (sox + either whisper binary or cloud API).
   */
  async isAvailable(): Promise<boolean> {
    const deps = await this.checkDependencies();

    if (!deps.soxInstalled) return false;

    if (this.config.mode === "cloud") {
      return isCloudAvailable(this.config.openaiApiKey);
    }

    // Local mode: need whisper binary (models auto-download on first use)
    return deps.whisperBinaryPath !== null;
  }

  /**
   * Get a human-readable status of what's missing.
   */
  async getSetupStatus(): Promise<{
    ready: boolean;
    missing: string[];
    hints: string[];
  }> {
    const deps = await this.checkDependencies();
    const missing: string[] = [];
    const hints: string[] = [];

    if (!deps.soxInstalled) {
      missing.push("sox (audio recorder)");
      hints.push(
        process.platform === "darwin"
          ? "Install with: brew install sox"
          : "Install with: sudo apt install sox"
      );
    }

    if (this.config.mode === "local") {
      if (!deps.whisperBinaryPath) {
        missing.push("whisper.cpp binary");
        hints.push(
          process.platform === "darwin"
            ? "Install with: brew install whisper-cpp"
            : "Build from source: https://github.com/ggerganov/whisper.cpp"
        );
      }

      if (deps.downloadedModels.length === 0) {
        missing.push(`Whisper ${this.config.model} model`);
        hints.push(`Will auto-download on first use (${this.modelManager.getModelInfo(this.config.model).sizeLabel})`);
      }
    } else {
      if (!isCloudAvailable(this.config.openaiApiKey)) {
        missing.push("OpenAI API key");
        hints.push("Set OPENAI_API_KEY environment variable");
      }
    }

    return {
      ready: missing.length === 0,
      missing,
      hints,
    };
  }

  // ============================================
  // Recording
  // ============================================

  /**
   * Start recording from the microphone.
   */
  async startRecording(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Cannot start recording in state: ${this.state}`);
    }

    // Check sox
    const soxCheck = await checkSoxInstalled();
    if (!soxCheck.installed) {
      this.emitError("SOX_NOT_INSTALLED", `sox not found. ${soxCheck.installHint}`);
      return;
    }

    this.recorder = new MicRecorder({
      maxDurationSeconds: this.config.maxRecordingSeconds,
    });

    // Forward audio level events
    this.recorder.on("audio-level", ({ level }) => {
      this.emit("audio-level", { level });

      // Feed VAD if enabled
      if (this.vad) {
        this.vad.processLevel(level);
      }
    });

    this.recorder.on("error", ({ message }) => {
      this.emitError("RECORDING_FAILED", message);
      this.setState("error");
    });

    try {
      await this.recorder.start();
      this.setState("recording");
      this.emit("recording-start");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start recording";
      this.emitError("RECORDING_FAILED", message);
    }
  }

  /**
   * Stop recording and transcribe the audio.
   * Returns the transcribed text.
   */
  async stopRecording(): Promise<TranscriptEvent | null> {
    if (this.state !== "recording" || !this.recorder) {
      return null;
    }

    try {
      const { path: wavPath, durationMs } = await this.recorder.stop();
      this.emit("recording-stop", { durationMs });

      // Skip transcription if recording was too short (likely accidental)
      if (durationMs < 200) {
        MicRecorder.cleanupFile(wavPath);
        return null;
      }

      // Transcribe
      this.setState("transcribing");
      const transcript = await this.transcribe(wavPath);

      // Clean up the WAV file
      MicRecorder.cleanupFile(wavPath);

      if (transcript && transcript.text) {
        this.emit("final-transcript", transcript);
      }

      this.setState("idle");
      return transcript;
    } catch (err) {
      this.setState("idle");
      const message = err instanceof Error ? err.message : "Transcription failed";
      this.emitError("TRANSCRIPTION_FAILED", message);
      return null;
    }
  }

  /**
   * Toggle recording (start if idle, stop if recording).
   */
  async toggleRecording(): Promise<TranscriptEvent | null> {
    if (this.state === "idle") {
      await this.startRecording();
      return null;
    } else if (this.state === "recording") {
      return this.stopRecording();
    }
    return null;
  }

  // ============================================
  // Transcription
  // ============================================

  private async transcribe(wavPath: string): Promise<TranscriptEvent | null> {
    if (this.config.mode === "cloud") {
      return this.transcribeCloud(wavPath);
    }
    return this.transcribeLocal(wavPath);
  }

  private async transcribeLocal(wavPath: string): Promise<TranscriptEvent | null> {
    // Ensure we have the whisper binary
    if (!this.whisperBinaryPath) {
      this.whisperBinaryPath = await findWhisperBinary();
    }

    if (!this.whisperBinaryPath) {
      this.emitError("NO_WHISPER_BINARY", "whisper.cpp binary not found. Install with: brew install whisper-cpp");
      return null;
    }

    // Ensure we have the model
    const modelPath = this.modelManager.getModelPath(this.config.model);
    if (!this.modelManager.isModelDownloaded(this.config.model)) {
      // Auto-download the model
      try {
        await this.modelManager.downloadModel(this.config.model);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Model download failed";
        this.emitError("MODEL_NOT_DOWNLOADED", message);
        return null;
      }
    }

    return transcribeLocal(wavPath, {
      binaryPath: this.whisperBinaryPath,
      modelPath,
      language: this.config.language,
      timeoutMs: 30000,
    });
  }

  private async transcribeCloud(wavPath: string): Promise<TranscriptEvent | null> {
    const apiKey = getApiKey(this.config.openaiApiKey);
    if (!apiKey) {
      this.emitError("CLOUD_API_KEY_MISSING", "OpenAI API key not set. Set OPENAI_API_KEY environment variable.");
      return null;
    }

    try {
      return await transcribeCloud(wavPath, {
        apiKey,
        language: this.config.language,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cloud transcription failed";
      this.emitError("CLOUD_API_ERROR", message);
      return null;
    }
  }

  // ============================================
  // VAD (Voice Activity Detection)
  // ============================================

  /**
   * Enable Voice Activity Detection for auto start/stop.
   */
  enableVAD(options?: { silenceDurationMs?: number; energyThreshold?: number }): void {
    this.vad = new VoiceActivityDetector({
      silenceDurationMs: options?.silenceDurationMs ?? this.config.vadSilenceMs,
      energyThreshold: options?.energyThreshold ?? 0.15,
    });

    this.vad.on("speech-start", () => {
      if (this.state === "idle") {
        this.startRecording().catch((err) => {
          this.emitError("RECORDING_FAILED", err.message);
        });
      }
    });

    this.vad.on("speech-end", () => {
      if (this.state === "recording") {
        this.stopRecording().catch((err) => {
          this.emitError("TRANSCRIPTION_FAILED", err instanceof Error ? err.message : "unknown");
        });
      }
    });

    this.vad.start();
    this.config.vadEnabled = true;
  }

  /**
   * Disable Voice Activity Detection.
   */
  disableVAD(): void {
    if (this.vad) {
      this.vad.stop();
      this.vad = null;
    }
    this.config.vadEnabled = false;
  }

  // ============================================
  // Model Management
  // ============================================

  /**
   * Get the model manager instance.
   */
  getModelManager(): WhisperModelManager {
    return this.modelManager;
  }

  /**
   * Switch to a different Whisper model.
   */
  async setModel(model: WhisperModelName): Promise<void> {
    this.config.model = model;

    // Download if needed
    if (!this.modelManager.isModelDownloaded(model)) {
      await this.modelManager.downloadModel(model);
    }
  }

  /**
   * Switch between local and cloud mode.
   */
  setMode(mode: "local" | "cloud"): void {
    this.config.mode = mode;
    // Reset dependency cache to re-check
    this.dependencyCache = null;
  }

  // ============================================
  // Configuration
  // ============================================

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<VoiceConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<VoiceConfig>): void {
    Object.assign(this.config, updates);

    if (updates.modelsPath) {
      this.modelManager = new WhisperModelManager(updates.modelsPath);
    }

    // Reset dependency cache
    this.dependencyCache = null;
  }

  /**
   * Enable voice input.
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * Disable voice input.
   */
  disable(): void {
    this.config.enabled = false;
    if (this.state === "recording") {
      this.stopRecording().catch(() => {});
    }
    this.disableVAD();
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up all resources.
   */
  async destroy(): Promise<void> {
    if (this.state === "recording") {
      await this.stopRecording();
    }
    this.disableVAD();
    this.removeAllListeners();
  }

  // ============================================
  // Private Helpers
  // ============================================

  private emitError(code: VoiceErrorCode, message: string): void {
    this.emit("error", { code, message });
  }
}
