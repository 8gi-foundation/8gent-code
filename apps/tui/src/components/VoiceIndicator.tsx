/**
 * VoiceIndicator — Recording status and audio level display for the TUI.
 *
 * Shows mic state (idle, recording, transcribing), audio level bar,
 * and current model info. Follows TUI color rules: no gray/white/black.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import {
  AppText,
  MutedText,
  Label,
  Badge,
  Inline,
} from "./primitives/index.js";
import type { RecordingState, WhisperModelName } from "@8gent/voice";

// ============================================
// Types
// ============================================

export interface VoiceIndicatorProps {
  /** Current recording state */
  state: RecordingState;
  /** Audio level (0-1) */
  audioLevel?: number;
  /** Current Whisper model name */
  model?: WhisperModelName | "cloud";
  /** Recording duration in ms */
  durationMs?: number;
  /** Partial transcript preview */
  partialTranscript?: string;
  /** Error message to display */
  errorMessage?: string | null;
  /** Model download progress (0-100) */
  downloadProgress?: number | null;
  /** Model being downloaded */
  downloadingModel?: WhisperModelName | null;
  /** Compact mode (for status bar) */
  compact?: boolean;
}

// ============================================
// Main Component
// ============================================

export function VoiceIndicator({
  state,
  audioLevel = 0,
  model = "tiny",
  durationMs = 0,
  partialTranscript,
  errorMessage,
  downloadProgress,
  downloadingModel,
  compact = false,
}: VoiceIndicatorProps) {
  // Downloading state takes priority
  if (downloadProgress !== null && downloadProgress !== undefined && downloadingModel) {
    return (
      <DownloadIndicator model={downloadingModel} progress={downloadProgress} />
    );
  }

  // Error state
  if (errorMessage) {
    return <ErrorIndicator message={errorMessage} />;
  }

  if (compact) {
    return (
      <CompactIndicator state={state} audioLevel={audioLevel} model={model} />
    );
  }

  // Full indicator
  return (
    <Box flexDirection="column">
      <Inline gap={1}>
        <MicIcon state={state} />
        <StateLabel state={state} durationMs={durationMs} />
        {state === "recording" && (
          <AudioLevelBar level={audioLevel} />
        )}
        {state === "idle" && (
          <MutedText>[Ctrl+Space to record]</MutedText>
        )}
      </Inline>

      {/* Partial transcript preview */}
      {state === "recording" && partialTranscript && (
        <Box paddingLeft={3}>
          <MutedText>{partialTranscript}</MutedText>
        </Box>
      )}

      {/* Transcribing spinner */}
      {state === "transcribing" && (
        <Box paddingLeft={3}>
          <TranscribingSpinner model={model} />
        </Box>
      )}
    </Box>
  );
}

// ============================================
// Sub-Components
// ============================================

/**
 * Animated microphone icon that pulses when recording.
 */
function MicIcon({ state }: { state: RecordingState }) {
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    if (state !== "recording") return;

    const interval = setInterval(() => {
      setPulse((prev) => !prev);
    }, 500);

    return () => clearInterval(interval);
  }, [state]);

  const configs: Record<RecordingState, { icon: string; color: string }> = {
    idle: { icon: "\u{1F3A4}", color: "cyan" },
    recording: { icon: pulse ? "\u{1F534}" : "\u{1F3A4}", color: "red" },
    transcribing: { icon: "\u{1F50D}", color: "yellow" },
    error: { icon: "\u26A0", color: "red" },
  };

  const config = configs[state];

  return (
    <AppText color={config.color as any} bold={state === "recording"}>
      {config.icon}
    </AppText>
  );
}

/**
 * State label with duration for recording.
 */
function StateLabel({
  state,
  durationMs,
}: {
  state: RecordingState;
  durationMs: number;
}) {
  const labels: Record<RecordingState, string> = {
    idle: "Voice ready",
    recording: "Recording",
    transcribing: "Transcribing",
    error: "Voice error",
  };

  const colors: Record<RecordingState, string> = {
    idle: "cyan",
    recording: "red",
    transcribing: "yellow",
    error: "red",
  };

  const durationStr = durationMs > 0
    ? ` ${(durationMs / 1000).toFixed(1)}s`
    : "";

  return (
    <Label color={colors[state] as any}>
      {labels[state]}{durationStr}
    </Label>
  );
}

/**
 * Audio level visualization bar.
 */
function AudioLevelBar({ level }: { level: number }) {
  const barWidth = 15;
  const filled = Math.round(level * barWidth);
  const empty = barWidth - filled;

  // Color transitions based on level
  const barColor = level > 0.7 ? "red" : level > 0.4 ? "yellow" : "green";

  const filledChars = "\u2588".repeat(filled);
  const emptyChars = "\u2591".repeat(empty);

  return (
    <Inline gap={0}>
      <MutedText>[</MutedText>
      <AppText color={barColor as any}>{filledChars}</AppText>
      <MutedText>{emptyChars}</MutedText>
      <MutedText>]</MutedText>
    </Inline>
  );
}

/**
 * Transcribing spinner with model info.
 */
function TranscribingSpinner({ model }: { model: WhisperModelName | "cloud" }) {
  const [frame, setFrame] = useState(0);
  const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return (
    <Inline gap={1}>
      <AppText color="yellow">{frames[frame]}</AppText>
      <MutedText>
        Transcribing with {model === "cloud" ? "OpenAI Whisper" : `whisper-${model}`}...
      </MutedText>
    </Inline>
  );
}

/**
 * Compact indicator for status bar integration.
 */
function CompactIndicator({
  state,
  audioLevel,
  model,
}: {
  state: RecordingState;
  audioLevel: number;
  model: WhisperModelName | "cloud";
}) {
  if (state === "idle") {
    return (
      <Badge label={"\u{1F3A4} Voice"} color="cyan" variant="outline" />
    );
  }

  if (state === "recording") {
    // Simple 3-bar level indicator
    const bars = audioLevel > 0.6 ? "\u2588\u2588\u2588" : audioLevel > 0.3 ? "\u2588\u2588\u2591" : "\u2588\u2591\u2591";
    return (
      <Inline gap={0}>
        <Badge label={"\u{1F534} REC"} color="red" variant="outline" />
        <AppText color="green"> {bars}</AppText>
      </Inline>
    );
  }

  if (state === "transcribing") {
    return (
      <Badge label={"\u{1F50D} STT"} color="yellow" variant="outline" />
    );
  }

  return null;
}

/**
 * Model download progress indicator.
 */
function DownloadIndicator({
  model,
  progress,
}: {
  model: WhisperModelName;
  progress: number;
}) {
  const barWidth = 20;
  const filled = Math.round((progress / 100) * barWidth);
  const empty = barWidth - filled;

  return (
    <Inline gap={1}>
      <AppText color="cyan">{"\u2B07"}</AppText>
      <Label color="cyan">Downloading whisper-{model}</Label>
      <MutedText>[</MutedText>
      <AppText color="green">{"\u2588".repeat(filled)}</AppText>
      <MutedText>{"\u2591".repeat(empty)}</MutedText>
      <MutedText>]</MutedText>
      <Label color="green">{progress}%</Label>
    </Inline>
  );
}

/**
 * Error indicator.
 */
function ErrorIndicator({ message }: { message: string }) {
  return (
    <Inline gap={1}>
      <AppText color="red">{"\u26A0"}</AppText>
      <Label color="red">Voice error:</Label>
      <MutedText>{message}</MutedText>
    </Inline>
  );
}

// ============================================
// Status Bar Voice Badge (standalone export)
// ============================================

/**
 * Minimal voice badge for embedding in the status bar.
 */
export function VoiceStatusBadge({
  enabled,
  state,
}: {
  enabled: boolean;
  state: RecordingState;
}) {
  if (!enabled) return null;

  const configs: Record<RecordingState, { label: string; color: string }> = {
    idle: { label: "\u{1F3A4}", color: "cyan" },
    recording: { label: "\u{1F534} REC", color: "red" },
    transcribing: { label: "\u{1F50D} STT", color: "yellow" },
    error: { label: "\u26A0 MIC", color: "red" },
  };

  const config = configs[state];

  return (
    <AppText color={config.color as any} bold={state === "recording"}>
      {config.label}
    </AppText>
  );
}
