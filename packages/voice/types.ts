/**
 * @8gent/voice — Type definitions
 *
 * All types for the voice input system: config, events, state, models.
 */

// ============================================
// Configuration
// ============================================

export interface VoiceConfig {
  /** Whether voice input is enabled */
  enabled: boolean;
  /** Transcription mode: local whisper.cpp or cloud OpenAI API */
  mode: "local" | "cloud";
  /** Which Whisper model to use for local transcription */
  model: WhisperModelName;
  /** Keyboard trigger for hold-to-speak */
  keybinding: string;
  /** Voice Activity Detection (auto start/stop) */
  vadEnabled: boolean;
  /** Silence duration in ms before VAD stops recording */
  vadSilenceMs: number;
  /** Transcription language (ISO 639-1) */
  language: string;
  /** Directory for Whisper model files */
  modelsPath: string;
  /** Max recording duration in seconds (safety limit) */
  maxRecordingSeconds: number;
  /** OpenAI API key for cloud mode (optional) */
  openaiApiKey?: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  mode: "local",
  model: "tiny",
  keybinding: "ctrl+space",
  vadEnabled: false,
  vadSilenceMs: 1500,
  language: "en",
  modelsPath: "~/.8gent/models/whisper",
  maxRecordingSeconds: 30,
};

// ============================================
// Whisper Models
// ============================================

export type WhisperModelName = "tiny" | "base" | "small";

export interface WhisperModelInfo {
  name: WhisperModelName;
  filename: string;
  /** File size in bytes */
  size: number;
  /** Human-readable size */
  sizeLabel: string;
  /** Download URL (Hugging Face) */
  url: string;
  /** SHA256 hash for verification */
  sha256: string;
  /** Relative transcription speed (1 = baseline) */
  speedFactor: number;
  /** Description for UI */
  description: string;
}

export const WHISPER_MODELS: Record<WhisperModelName, WhisperModelInfo> = {
  tiny: {
    name: "tiny",
    filename: "ggml-tiny.bin",
    size: 39_000_000,
    sizeLabel: "39 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    speedFactor: 1,
    description: "Fastest, good for real-time. ~200ms for 5s audio on Apple Silicon.",
  },
  base: {
    name: "base",
    filename: "ggml-base.bin",
    size: 74_000_000,
    sizeLabel: "74 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    speedFactor: 2,
    description: "Balanced speed and accuracy. ~800ms for 5s audio.",
  },
  small: {
    name: "small",
    filename: "ggml-small.bin",
    size: 244_000_000,
    sizeLabel: "244 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1571c230d4",
    speedFactor: 4,
    description: "Most accurate, slower. ~3s for 5s audio.",
  },
};

// ============================================
// Recording State
// ============================================

export type RecordingState = "idle" | "recording" | "transcribing" | "error";

export interface RecordingStatus {
  state: RecordingState;
  /** Audio level (RMS energy), 0-1 */
  audioLevel: number;
  /** Duration of current recording in ms */
  durationMs: number;
  /** Error message if state is 'error' */
  errorMessage?: string;
}

// ============================================
// Transcript Events
// ============================================

export interface TranscriptEvent {
  /** The transcribed text */
  text: string;
  /** Whether this is a partial (streaming) or final result */
  isFinal: boolean;
  /** Transcription duration in ms */
  durationMs: number;
  /** Which model produced this */
  model: WhisperModelName | "cloud";
  /** Audio duration in ms */
  audioDurationMs: number;
}

// ============================================
// Voice Engine Events
// ============================================

export type VoiceEventMap = {
  "recording-start": [];
  "recording-stop": [{ durationMs: number }];
  "audio-level": [{ level: number }];
  "partial-transcript": [TranscriptEvent];
  "final-transcript": [TranscriptEvent];
  "error": [{ code: VoiceErrorCode; message: string }];
  "model-download-progress": [{ model: WhisperModelName; percent: number; bytesDownloaded: number; bytesTotal: number }];
  "model-download-complete": [{ model: WhisperModelName }];
  "state-change": [{ from: RecordingState; to: RecordingState }];
};

export type VoiceErrorCode =
  | "SOX_NOT_INSTALLED"
  | "MIC_ACCESS_DENIED"
  | "NO_WHISPER_BINARY"
  | "MODEL_NOT_DOWNLOADED"
  | "TRANSCRIPTION_TIMEOUT"
  | "TRANSCRIPTION_FAILED"
  | "RECORDING_FAILED"
  | "CLOUD_API_ERROR"
  | "CLOUD_API_KEY_MISSING"
  | "MAX_DURATION_EXCEEDED"
  | "UNKNOWN";

// ============================================
// Dependency Check Results
// ============================================

export interface DependencyCheckResult {
  soxInstalled: boolean;
  soxPath: string | null;
  whisperBinaryPath: string | null;
  modelsDir: string;
  downloadedModels: WhisperModelName[];
  micAvailable: boolean;
}
