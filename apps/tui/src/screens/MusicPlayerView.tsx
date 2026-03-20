/**
 * 8gent Code - Music Player View
 *
 * A dedicated view for browsing generated tracks, playback controls,
 * and music generation. Accessible via Shift+Tab cycle or /music player.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { AppText, MutedText, Label, Stack, Divider } from "../components/primitives/index.js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";

const CACHE_DIR = join(process.env.HOME || "~", ".8gent", "adhd-audio");

interface Track {
  name: string;
  path: string;
  size: string;
  modified: string;
  playing: boolean;
}

interface MusicPlayerViewProps {
  visible: boolean;
  isPlaying: boolean;
  currentTrack: string | null;
  onPlay: (soundscape: string) => void;
  onStop: () => void;
  onClose: () => void;
  onGenerate: (prompt: string) => void;
  duration: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function loadTracks(currentTrack: string | null): Track[] {
  const tracks: Track[] = [];
  if (!existsSync(CACHE_DIR)) return tracks;

  try {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".mp3") || f.endsWith(".wav"));
    for (const file of files) {
      const filePath = join(CACHE_DIR, file);
      const stat = statSync(filePath);
      const name = basename(file, ".mp3").replace(/-/g, " ");
      tracks.push({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        path: filePath,
        size: formatBytes(stat.size),
        modified: formatDate(stat.mtime),
        playing: currentTrack === name.toLowerCase() || currentTrack === basename(file, ".mp3"),
      });
    }
  } catch { /* empty */ }

  return tracks;
}

const PRESETS = [
  { key: "lofi", label: "Lofi Hip Hop", desc: "Chill beats, vinyl crackle, mellow piano" },
  { key: "rainsound", label: "Rain & Thunder", desc: "Gentle rain on a window, distant thunder" },
  { key: "whitenoise", label: "White Noise", desc: "Soft static, consistent hum" },
  { key: "ambient", label: "Ambient Synths", desc: "Ethereal pads, floating textures" },
  { key: "classical", label: "Soft Piano", desc: "Contemplative, minimalist piano" },
];

export function MusicPlayerView({
  visible,
  isPlaying,
  currentTrack,
  onPlay,
  onStop,
  onClose,
  onGenerate,
  duration,
}: MusicPlayerViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [section, setSection] = useState<"playlist" | "presets">("playlist");
  const [tracks, setTracks] = useState<Track[]>([]);

  // Refresh track list
  useEffect(() => {
    if (visible) {
      setTracks(loadTracks(currentTrack));
    }
  }, [visible, currentTrack]);

  const totalItems = section === "playlist" ? tracks.length : PRESETS.length;

  useInput((input, key) => {
    if (!visible) return;

    // Navigation
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(totalItems - 1, prev + 1));
    }

    // Tab: switch between playlist and presets
    if (key.tab && !key.shift) {
      setSection(prev => prev === "playlist" ? "presets" : "playlist");
      setSelectedIndex(0);
    }

    // Enter: play selected
    if (key.return) {
      if (section === "presets") {
        const preset = PRESETS[selectedIndex];
        if (preset) onPlay(preset.key);
      } else if (section === "playlist" && tracks[selectedIndex]) {
        // Play from cache — use the track name as soundscape key
        const trackName = basename(tracks[selectedIndex].path, ".mp3");
        onPlay(trackName);
      }
    }

    // Space: toggle play/pause
    if (input === " ") {
      if (isPlaying) {
        onStop();
      } else if (currentTrack) {
        onPlay(currentTrack);
      }
    }

    // S: stop
    if (input === "s" || input === "S") {
      onStop();
    }

    // Escape or Q: close
    if (key.escape || input === "q") {
      onClose();
    }
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="magenta">🎵 Music Player</Text>
        <MutedText>  {isPlaying ? `▶ Playing: ${currentTrack}` : "⏸ Stopped"}</MutedText>
        <Box flexGrow={1} />
        <MutedText>Duration: {duration}s</MutedText>
      </Box>

      <Divider />

      {/* Now Playing bar */}
      {isPlaying && (
        <Box marginY={1} borderStyle="round" borderColor="magenta" paddingX={2} paddingY={0}>
          <Text color="magenta" bold>▶ </Text>
          <AppText bold>{currentTrack}</AppText>
          <MutedText>  •  looping  •  </MutedText>
          <MutedText>Space=pause  S=stop</MutedText>
        </Box>
      )}

      {/* Section tabs */}
      <Box marginBottom={1}>
        <Text
          bold={section === "playlist"}
          color={section === "playlist" ? "cyan" : undefined}
          dimColor={section !== "playlist"}
        >
          [Playlist]
        </Text>
        <MutedText>  </MutedText>
        <Text
          bold={section === "presets"}
          color={section === "presets" ? "cyan" : undefined}
          dimColor={section !== "presets"}
        >
          [Generate New]
        </Text>
        <MutedText>    Tab to switch</MutedText>
      </Box>

      {/* Content */}
      {section === "playlist" ? (
        <Box flexDirection="column">
          {tracks.length === 0 ? (
            <Box paddingY={1}>
              <MutedText>No tracks yet. Switch to [Generate New] to create some.</MutedText>
            </Box>
          ) : (
            tracks.map((track, i) => (
              <Box key={track.path}>
                <Text color={i === selectedIndex ? "cyan" : undefined}>
                  {i === selectedIndex ? "❯ " : "  "}
                </Text>
                <Text color={track.playing ? "magenta" : undefined} bold={track.playing}>
                  {track.playing ? "▶ " : "  "}
                  {track.name}
                </Text>
                <Box flexGrow={1} />
                <MutedText>{track.size}  {track.modified}</MutedText>
              </Box>
            ))
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          {PRESETS.map((preset, i) => (
            <Box key={preset.key} marginBottom={0}>
              <Text color={i === selectedIndex ? "cyan" : undefined}>
                {i === selectedIndex ? "❯ " : "  "}
              </Text>
              <AppText bold={i === selectedIndex}>{preset.label}</AppText>
              <MutedText>  {preset.desc}</MutedText>
            </Box>
          ))}

          <Box marginTop={1}>
            <Divider />
          </Box>
          <Box marginTop={1}>
            <MutedText>Enter=generate & play  •  Custom: /music gen your prompt here</MutedText>
          </Box>
        </Box>
      )}

      {/* Footer controls */}
      <Box marginTop={1}>
        <Divider />
      </Box>
      <Box>
        <MutedText>
          ↑↓ navigate  Enter=play  Space=pause  S=stop  Tab=switch section  ESC=back to chat
        </MutedText>
      </Box>
    </Box>
  );
}
