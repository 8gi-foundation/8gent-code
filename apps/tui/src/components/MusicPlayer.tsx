/**
 * MusicPlayer - Right-side panel with audio visualizer, now-playing info.
 *
 * Eight is the autonomous DJ. Users make requests, he commands the system.
 * Shows animated equalizer bars, track info, volume, and playback state.
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";

// ---- Visualizer Bar Characters ----
const BARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const NUM_BARS = 12;

interface MusicPlayerProps {
  isPlaying: boolean;
  isPaused?: boolean;
  isLooping?: boolean;
  trackTitle?: string;
  genre?: string;
  bpm?: number;
  volume?: number;          // 0-100
  position?: number;        // seconds
  duration?: number;        // seconds
  queueLength?: number;
  width?: number;
}

// ---- Animated Equalizer ----
function Equalizer({ playing, width = 12 }: { playing: boolean; width?: number }) {
  const [bars, setBars] = useState<number[]>(Array(width).fill(0));
  const frameRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (playing) {
      frameRef.current = setInterval(() => {
        setBars((prev) =>
          prev.map((v) => {
            // Smooth random movement with momentum
            const target = Math.floor(Math.random() * 8);
            const delta = target - v;
            return Math.max(0, Math.min(8, v + Math.sign(delta) * Math.ceil(Math.abs(delta) * 0.6)));
          })
        );
      }, 120);
    } else {
      // Decay to zero
      frameRef.current = setInterval(() => {
        setBars((prev) => {
          const next = prev.map((v) => Math.max(0, v - 1));
          if (next.every((v) => v === 0) && frameRef.current) {
            clearInterval(frameRef.current);
          }
          return next;
        });
      }, 80);
    }

    return () => {
      if (frameRef.current) clearInterval(frameRef.current);
    };
  }, [playing]);

  return (
    <Box flexDirection="row" gap={0}>
      {bars.map((level, i) => (
        <Text key={i} color={level > 5 ? "#F07A28" : level > 2 ? "cyan" : "blue"}>
          {BARS[level]}
        </Text>
      ))}
    </Box>
  );
}

// ---- Progress Bar ----
function ProgressBar({ position, duration, width = 14 }: { position: number; duration: number; width?: number }) {
  const pct = duration > 0 ? Math.min(position / duration, 1) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;

  return (
    <Box>
      <Text color="cyan">{"━".repeat(filled)}</Text>
      <Text color="cyan" bold>{"●"}</Text>
      <Text dimColor>{"━".repeat(Math.max(0, empty - 1))}</Text>
    </Box>
  );
}

// ---- Volume Indicator ----
function VolumeBar({ volume }: { volume: number }) {
  const blocks = Math.round((volume / 100) * 5);
  return (
    <Box>
      <Text dimColor>Vol </Text>
      <Text color="green">{"█".repeat(blocks)}</Text>
      <Text dimColor>{"░".repeat(5 - blocks)}</Text>
    </Box>
  );
}

// ---- Time Format ----
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// ---- Main Component ----
export function MusicPlayer({
  isPlaying,
  isPaused = false,
  isLooping = false,
  trackTitle,
  genre,
  bpm,
  volume = 80,
  position = 0,
  duration = 0,
  queueLength = 0,
  width = 20,
}: MusicPlayerProps) {
  if (!isPlaying && !trackTitle) return null;

  const icon = isPaused ? "⏸" : isLooping ? "🔁" : "▶";
  const statusColor = isPaused ? "yellow" : "green";
  const truncTitle = trackTitle && trackTitle.length > width - 2
    ? trackTitle.slice(0, width - 5) + "..."
    : trackTitle || "---";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      width={width}
    >
      {/* Header */}
      <Box justifyContent="center">
        <Text bold color="cyan">
          {"♪ DJ Eight ♪"}
        </Text>
      </Box>

      {/* Visualizer */}
      <Box justifyContent="center" marginY={0}>
        <Equalizer playing={isPlaying && !isPaused} width={Math.min(NUM_BARS, width - 4)} />
      </Box>

      {/* Track Title */}
      <Box marginTop={0}>
        <Text color={statusColor}>{icon} </Text>
        <Text bold wrap="truncate-end">{truncTitle}</Text>
      </Box>

      {/* Genre + BPM */}
      {(genre || bpm) && (
        <Box>
          <Text dimColor>
            {genre || ""}{genre && bpm ? " " : ""}{bpm ? `${bpm}bpm` : ""}
          </Text>
        </Box>
      )}

      {/* Progress */}
      {duration > 0 && (
        <Box flexDirection="column">
          <ProgressBar position={position} duration={duration} width={width - 4} />
          <Box justifyContent="space-between">
            <Text dimColor>{fmt(position)}</Text>
            <Text dimColor>{fmt(duration)}</Text>
          </Box>
        </Box>
      )}

      {/* Volume */}
      <VolumeBar volume={volume} />

      {/* Queue */}
      {queueLength > 0 && (
        <Box>
          <Text dimColor>Queue: </Text>
          <Text color="#F07A28">{queueLength} tracks</Text>
        </Box>
      )}
    </Box>
  );
}

export default MusicPlayer;
