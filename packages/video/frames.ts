/**
 * Frame extraction — adaptive fps budgeting by duration.
 *
 * Inspired by claude-video's approach: dense extraction for short videos,
 * sparse sampling for long ones. Caps at 100 frames / 2 fps to control token cost.
 *
 * Token cost scales with frame count, so budget-by-duration keeps
 * short videos dense and long videos capped.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const MAX_FPS = 2;
export const ABSOLUTE_MAX_FRAMES = 100;

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
}

export interface ExtractedFrame {
  path: string;
  timestampSeconds: number;
}

export interface FpsBudget {
  fps: number;
  targetFrames: number;
}

/** Parse time strings: "SS", "MM:SS", or "HH:MM:SS" → seconds. */
export function parseTime(t: string | undefined | null): number | null {
  if (t == null) return null;
  const parts = t.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** Format seconds → "MM:SS" or "HH:MM:SS". */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Get video metadata via ffprobe. */
export function getMetadata(videoPath: string): VideoMetadata {
  const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`;
  const raw = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
  const data = JSON.parse(raw);

  const videoStream = data.streams?.find((s: any) => s.codec_type === "video");
  const duration = parseFloat(data.format?.duration || videoStream?.duration || "0");

  return {
    durationSeconds: duration,
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    codec: videoStream?.codec_name || "unknown",
  };
}

/** Auto-calculate fps for full-video scan. */
export function autoFps(duration: number, maxFrames = 80): FpsBudget {
  maxFrames = Math.min(maxFrames, ABSOLUTE_MAX_FRAMES);

  let target: number;
  if (duration <= 10) target = Math.min(Math.ceil(duration * 2), 20);
  else if (duration <= 30) target = 30;
  else if (duration <= 60) target = 40;
  else if (duration <= 180) target = 60;
  else if (duration <= 600) target = 80;
  else target = maxFrames;

  target = Math.min(target, maxFrames);
  const fps = Math.min(target / Math.max(duration, 0.1), MAX_FPS);

  return { fps: Math.max(fps, 0.01), targetFrames: target };
}

/** Auto-calculate fps for focused range (denser sampling). */
export function autoFpsFocus(duration: number, maxFrames = 80): FpsBudget {
  maxFrames = Math.min(maxFrames, ABSOLUTE_MAX_FRAMES);

  let target: number;
  if (duration <= 5) target = Math.min(10, maxFrames);
  else if (duration <= 15) target = Math.min(30, maxFrames);
  else if (duration <= 30) target = Math.min(60, maxFrames);
  else if (duration <= 60) target = Math.min(80, maxFrames);
  else target = maxFrames;

  const fps = Math.min(target / Math.max(duration, 0.1), MAX_FPS);
  return { fps: Math.max(fps, 0.01), targetFrames: target };
}

/** Extract frames from a video. */
export function extractFrames(
  videoPath: string,
  outDir: string,
  opts: {
    fps: number;
    resolution?: number;
    maxFrames?: number;
    startSeconds?: number | null;
    endSeconds?: number | null;
  }
): ExtractedFrame[] {
  fs.mkdirSync(outDir, { recursive: true });

  const { fps, resolution = 512, maxFrames = 80, startSeconds, endSeconds } = opts;
  const clampedMaxFrames = Math.min(maxFrames, ABSOLUTE_MAX_FRAMES);

  let cmd = "ffmpeg -v quiet";
  if (startSeconds != null) cmd += ` -ss ${startSeconds}`;
  cmd += ` -i "${videoPath}"`;
  if (endSeconds != null) {
    const dur = endSeconds - (startSeconds || 0);
    cmd += ` -t ${dur}`;
  }
  cmd += ` -vf "fps=${fps},scale=${resolution}:-2" -q:v 5`;
  cmd += ` -frames:v ${clampedMaxFrames}`;
  cmd += ` "${path.join(outDir, "frame_%05d.jpg")}"`;

  execSync(cmd, { timeout: 120_000 });

  // Collect extracted frames with timestamps
  const files = fs.readdirSync(outDir)
    .filter(f => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort();

  const offset = startSeconds || 0;
  return files.map((file, i) => ({
    path: path.join(outDir, file),
    timestampSeconds: offset + (i / fps),
  }));
}
