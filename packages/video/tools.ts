/**
 * Video tools — registered in the 8gent toolshed.
 *
 * watch_video: Full pipeline — download, extract, transcribe, report
 * video_frames: Extract frames only (for local files or re-extraction)
 * video_transcribe: Transcribe only (captions or Whisper)
 * video_metadata: Quick metadata probe (duration, resolution, codec)
 * video_check_deps: Verify yt-dlp, ffmpeg, ffprobe are installed
 */

import { registerTool } from "../toolshed/registry/register";
import type { ExecutionContext } from "../types";

// ── watch_video — Full Pipeline ────────────────────────────

registerTool({
  name: "watch_video",
  description:
    "Analyze a video from a URL (YouTube, Vimeo, TikTok, etc.) or local file path. " +
    "Downloads with yt-dlp, extracts auto-scaled frames with ffmpeg, pulls the transcript " +
    "from captions (or Whisper API fallback), and returns a structured report with frame " +
    "paths and timestamped transcript. Read each frame path to see the images.",
  capabilities: ["execution"],
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Video URL or local file path" },
      maxFrames: { type: "number", description: "Max frames to extract (default: 80, hard max: 100)" },
      resolution: { type: "number", description: "Frame width in px (default: 512, use 1024 for text-heavy)" },
      fps: { type: "number", description: "Override auto-fps (capped at 2)" },
      start: { type: "string", description: "Range start: SS, MM:SS, or HH:MM:SS" },
      end: { type: "string", description: "Range end: SS, MM:SS, or HH:MM:SS" },
      noWhisper: { type: "boolean", description: "Disable Whisper fallback (frames-only if no captions)" },
      whisperBackend: { type: "string", description: "'groq' or 'openai' (default: prefer groq)" },
    },
    required: ["source"],
  },
  permissions: ["exec:shell", "net:fetch"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const opts = input as {
    source: string; maxFrames?: number; resolution?: number; fps?: number;
    start?: string; end?: string; noWhisper?: boolean; whisperBackend?: "groq" | "openai";
  };

  const { watch, formatReport } = await import("./watch");
  const report = await watch(opts);
  return {
    report: formatReport(report),
    frameCount: report.frameCount,
    framePaths: report.frames.map(f => f.path),
    transcriptSource: report.transcript.source,
    transcriptSegments: report.transcript.segmentCount,
    workDir: report.workDir,
    warnings: report.warnings,
  };
});

// ── video_metadata — Quick Probe ───────────────────────────

registerTool({
  name: "video_metadata",
  description: "Get video metadata: duration, resolution, codec. Fast — no download or extraction.",
  capabilities: ["execution"],
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to local video file" },
    },
    required: ["path"],
  },
  permissions: ["exec:shell"],
}, async (input: unknown, _ctx: ExecutionContext) => {
  const { path: videoPath } = input as { path: string };
  const { getMetadata } = await import("./frames");
  const { formatTime } = await import("./frames");

  const meta = getMetadata(videoPath);
  return {
    duration: meta.durationSeconds,
    durationFormatted: formatTime(meta.durationSeconds),
    width: meta.width,
    height: meta.height,
    resolution: meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown",
    codec: meta.codec,
  };
});

// ── video_frames — Extract Frames Only ─────────────────────

registerTool({
  name: "video_frames",
  description: "Extract frames from a local video file. Returns paths to JPEG images with timestamps.",
  capabilities: ["execution"],
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to video file" },
      outDir: { type: "string", description: "Output directory for frames" },
      maxFrames: { type: "number", description: "Max frames (default: 80)" },
      resolution: { type: "number", description: "Frame width in px (default: 512)" },
      fps: { type: "number", description: "Override auto-fps" },
      start: { type: "string", description: "Start time (SS, MM:SS, or HH:MM:SS)" },
      end: { type: "string", description: "End time" },
    },
    required: ["path", "outDir"],
  },
  permissions: ["exec:shell"],
}, async (input: unknown, _ctx: ExecutionContext) => {
  const opts = input as {
    path: string; outDir: string; maxFrames?: number; resolution?: number;
    fps?: number; start?: string; end?: string;
  };

  const { getMetadata, autoFps, autoFpsFocus, extractFrames, parseTime, formatTime, MAX_FPS } = await import("./frames");

  const meta = getMetadata(opts.path);
  const startSec = parseTime(opts.start);
  const endSec = parseTime(opts.end);
  const focused = startSec != null || endSec != null;
  const effectiveDuration = (endSec ?? meta.durationSeconds) - (startSec ?? 0);

  const budget = focused
    ? autoFpsFocus(effectiveDuration, opts.maxFrames)
    : autoFps(effectiveDuration, opts.maxFrames);

  const fps = opts.fps ? Math.min(opts.fps, MAX_FPS) : budget.fps;

  const frames = extractFrames(opts.path, opts.outDir, {
    fps,
    resolution: opts.resolution || 512,
    maxFrames: opts.maxFrames || 80,
    startSeconds: startSec,
    endSeconds: endSec,
  });

  return {
    frameCount: frames.length,
    fps: fps.toFixed(3),
    mode: focused ? "focused" : "full",
    frames: frames.map(f => ({
      path: f.path,
      timestamp: formatTime(f.timestampSeconds),
    })),
  };
});

// ── video_transcribe — Transcription Only ──────────────────

registerTool({
  name: "video_transcribe",
  description: "Transcribe a video using native captions or Whisper API fallback.",
  capabilities: ["execution"],
  inputSchema: {
    type: "object",
    properties: {
      videoPath: { type: "string", description: "Path to video file" },
      subtitlePath: { type: "string", description: "Path to VTT subtitle file (optional)" },
      noWhisper: { type: "boolean", description: "Disable Whisper fallback" },
      whisperBackend: { type: "string", description: "'groq' or 'openai'" },
      start: { type: "string", description: "Filter start time" },
      end: { type: "string", description: "Filter end time" },
    },
    required: ["videoPath"],
  },
  permissions: ["exec:shell", "net:fetch"],
}, async (input: unknown, _ctx: ExecutionContext) => {
  const opts = input as {
    videoPath: string; subtitlePath?: string; noWhisper?: boolean;
    whisperBackend?: "groq" | "openai"; start?: string; end?: string;
  };

  const { transcribe } = await import("./transcribe");
  const { parseTime } = await import("./frames");
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-transcribe-"));
  const result = await transcribe(
    opts.videoPath,
    opts.subtitlePath || null,
    workDir,
    {
      noWhisper: opts.noWhisper,
      whisperBackend: opts.whisperBackend,
      startSeconds: parseTime(opts.start),
      endSeconds: parseTime(opts.end),
    }
  );

  return {
    source: result.source,
    segmentCount: result.segments.length,
    transcript: result.text,
    workDir,
  };
});

// ── video_check_deps — Dependency Check ────────────────────

registerTool({
  name: "video_check_deps",
  description: "Check if video dependencies (yt-dlp, ffmpeg, ffprobe) are installed. Optionally auto-install.",
  capabilities: ["execution"],
  inputSchema: {
    type: "object",
    properties: {
      install: { type: "boolean", description: "Auto-install missing deps (default: false)" },
    },
  },
  permissions: ["exec:shell"],
}, async (input: unknown, _ctx: ExecutionContext) => {
  const { install = false } = input as { install?: boolean };
  const { checkDeps, installDeps } = await import("./deps");

  const status = checkDeps();
  if (status.ready) {
    return { ready: true, message: "All video dependencies are installed." };
  }

  if (install) {
    const result = installDeps();
    const finalStatus = checkDeps();
    return {
      ready: finalStatus.ready,
      installed: result.installed,
      failed: result.failed,
      stillMissing: finalStatus.missing,
    };
  }

  return {
    ready: false,
    missing: status.missing,
    platform: status.platform,
    message: `Missing: ${status.missing.join(", ")}. Run with install:true to auto-install.`,
  };
});
