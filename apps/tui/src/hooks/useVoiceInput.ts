/**
 * useVoiceInput — React hook for voice input in the 8gent TUI
 *
 * Wraps the @8gent/voice VoiceEngine for use in Ink components.
 * Handles keyboard trigger, state management, and cleanup.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useInput } from "ink";
import {
  VoiceEngine,
  type VoiceConfig,
  type RecordingState,
  type TranscriptEvent,
  type WhisperModelName,
  type VoiceErrorCode,
} from "@8gent/voice";

export interface UseVoiceInputOptions {
  /** Voice configuration overrides */
  config?: Partial<VoiceConfig>;
  /** Whether voice input is active (can record) */
  active?: boolean;
  /** Callback when a final transcript is received */
  onTranscript?: (text: string) => void;
  /** Callback when an error occurs */
  onError?: (code: VoiceErrorCode, message: string) => void;
  /** Callback for model download progress */
  onDownloadProgress?: (model: WhisperModelName, percent: number) => void;
}

export interface UseVoiceInputReturn {
  /** Current recording state */
  state: RecordingState;
  /** Whether currently recording */
  isRecording: boolean;
  /** Whether currently transcribing */
  isTranscribing: boolean;
  /** Whether voice is available (dependencies met) */
  isAvailable: boolean | null;
  /** Current audio level (0-1) */
  audioLevel: number;
  /** Last transcript text */
  transcript: string;
  /** Partial transcript (during streaming) */
  partialTranscript: string;
  /** Last error message */
  errorMessage: string | null;
  /** Recording duration in ms */
  recordingDurationMs: number;
  /** Model download progress (0-100, null if not downloading) */
  downloadProgress: number | null;
  /** Currently downloading model name */
  downloadingModel: WhisperModelName | null;
  /** Setup status */
  setupStatus: { ready: boolean; missing: string[]; hints: string[] } | null;
  /** Start recording */
  start: () => Promise<void>;
  /** Stop recording (triggers transcription) */
  stop: () => Promise<TranscriptEvent | null>;
  /** Toggle recording */
  toggle: () => Promise<void>;
  /** Enable voice */
  enable: () => void;
  /** Disable voice */
  disable: () => void;
  /** Check dependencies */
  checkSetup: () => Promise<void>;
  /** The VoiceEngine instance (for advanced use) */
  engine: VoiceEngine;
}

/**
 * React hook for voice input in the TUI.
 *
 * Provides Ctrl+Space toggle for recording, real-time state updates,
 * and transcript injection.
 *
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   const voice = useVoiceInput({
 *     onTranscript: (text) => setInput(prev => prev + text),
 *   });
 *
 *   return (
 *     <Box>
 *       {voice.isRecording && <Text color="red">Recording...</Text>}
 *       {voice.transcript && <Text>{voice.transcript}</Text>}
 *     </Box>
 *   );
 * }
 * ```
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const {
    config = {},
    active = true,
    onTranscript,
    onError,
    onDownloadProgress,
  } = options;

  // Create engine once, update config via ref
  const engineRef = useRef<VoiceEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new VoiceEngine(config);
  }
  const engine = engineRef.current;

  // State
  const [state, setState] = useState<RecordingState>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<WhisperModelName | null>(null);
  const [setupStatus, setSetupStatus] = useState<{
    ready: boolean;
    missing: string[];
    hints: string[];
  } | null>(null);

  // Duration timer
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Wire up engine events
  useEffect(() => {
    const onStateChange = ({ to }: { from: RecordingState; to: RecordingState }) => {
      setState(to);
    };

    const onAudioLevel = ({ level }: { level: number }) => {
      setAudioLevel(level);
    };

    const onFinalTranscript = (event: TranscriptEvent) => {
      setTranscript(event.text);
      setPartialTranscript("");
      if (event.text && onTranscript) {
        onTranscript(event.text);
      }
    };

    const onPartialTranscript = (event: TranscriptEvent) => {
      setPartialTranscript(event.text);
    };

    const onEngineError = ({ code, message }: { code: VoiceErrorCode; message: string }) => {
      setErrorMessage(message);
      if (onError) {
        onError(code, message);
      }
      // Auto-clear error after 5s
      setTimeout(() => setErrorMessage(null), 5000);
    };

    const onModelProgress = ({
      model,
      percent,
    }: {
      model: WhisperModelName;
      percent: number;
      bytesDownloaded: number;
      bytesTotal: number;
    }) => {
      setDownloadProgress(percent);
      setDownloadingModel(model);
      if (onDownloadProgress) {
        onDownloadProgress(model, percent);
      }
    };

    const onModelComplete = () => {
      setDownloadProgress(null);
      setDownloadingModel(null);
    };

    engine.on("state-change", onStateChange);
    engine.on("audio-level", onAudioLevel);
    engine.on("final-transcript", onFinalTranscript);
    engine.on("partial-transcript", onPartialTranscript);
    engine.on("error", onEngineError);
    engine.on("model-download-progress", onModelProgress);
    engine.on("model-download-complete", onModelComplete);

    return () => {
      engine.off("state-change", onStateChange);
      engine.off("audio-level", onAudioLevel);
      engine.off("final-transcript", onFinalTranscript);
      engine.off("partial-transcript", onPartialTranscript);
      engine.off("error", onEngineError);
      engine.off("model-download-progress", onModelProgress);
      engine.off("model-download-complete", onModelComplete);
    };
  }, [engine, onTranscript, onError, onDownloadProgress]);

  // Recording duration timer
  useEffect(() => {
    if (state === "recording") {
      const startTime = Date.now();
      durationTimerRef.current = setInterval(() => {
        setRecordingDurationMs(Date.now() - startTime);
      }, 100);
    } else {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (state === "idle") {
        setRecordingDurationMs(0);
        setAudioLevel(0);
      }
    }

    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
      }
    };
  }, [state]);

  // Check availability on mount
  useEffect(() => {
    engine.isAvailable().then((available) => {
      setIsAvailable(available);
      engine.getSetupStatus().then(setSetupStatus).catch(() => {});
    }).catch(() => setIsAvailable(false));
  }, [engine]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      engine.destroy().catch(() => {});
    };
  }, [engine]);

  // Keyboard handler: Ctrl+Space to toggle recording
  useInput(
    (input, key) => {
      // Ctrl+Space — terminal sends ctrl+@ which is NUL (0x00)
      // Some terminals send ctrl+space as a space with ctrl modifier
      if (key.ctrl && (input === " " || input === "\0" || input === "@")) {
        toggle().catch(() => {});
      }
    },
    { isActive: active && engine.isEnabled() },
  );

  // Actions
  const start = useCallback(async () => {
    setErrorMessage(null);
    setTranscript("");
    await engine.startRecording();
  }, [engine]);

  const stop = useCallback(async () => {
    return engine.stopRecording();
  }, [engine]);

  const toggle = useCallback(async () => {
    if (engine.getState() === "idle") {
      await start();
    } else if (engine.getState() === "recording") {
      await stop();
    }
  }, [engine, start, stop]);

  const enable = useCallback(() => {
    engine.enable();
  }, [engine]);

  const disable = useCallback(() => {
    engine.disable();
  }, [engine]);

  const checkSetup = useCallback(async () => {
    const available = await engine.isAvailable();
    setIsAvailable(available);
    const status = await engine.getSetupStatus();
    setSetupStatus(status);
  }, [engine]);

  return {
    state,
    isRecording: state === "recording",
    isTranscribing: state === "transcribing",
    isAvailable,
    audioLevel,
    transcript,
    partialTranscript,
    errorMessage,
    recordingDurationMs,
    downloadProgress,
    downloadingModel,
    setupStatus,
    start,
    stop,
    toggle,
    enable,
    disable,
    checkSetup,
    engine,
  };
}
