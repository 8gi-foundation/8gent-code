/**
 * /watch — Main entry point for video analysis.
 *
 * Downloads video → extracts frames → transcribes → returns structured report.
 * Inspired by bradautomates/claude-video, adapted for 8gent's TypeScript/Bun stack.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { isUrl, resolveLocal, downloadUrl } from "./download";
import { getMetadata, autoFps, autoFpsFocus, extractFrames, formatTime, parseTime, MAX_FPS } from "./frames";
import { transcribe } from "./transcribe";

export interface WatchOptions {
  source: string;
  maxFrames?: number;
  resolution?: number;
  fps?: number;
  start?: string;
  end?: string;
  outDir?: string;
  noWhisper?: boolean;
  whisperBackend?: "groq" | "openai";
}

export interface WatchReport {
  source: string;
  title?: string;
  uploader?: string;
  duration: number;
  durationFormatted: string;
  resolution?: string;
  codec?: string;

  focused: boolean;
  focusRange?: { start: string; end: string; duration: number };

  frames: Array<{ path: string; timestamp: string; timestampSeconds: number }>;
  frameCount: number;
  fps: number;
  frameMode: "full" | "focused";
  frameResolution: number;

  transcript: {
    source: "captions" | "whisper-groq" | "whisper-openai" | "none";
    segmentCount: number;
    text: string;
  };

  workDir: string;
  warnings: string[];
}

export async function watch(opts: WatchOptions): Promise<WatchReport> {
  const {
    source,
    maxFrames: maxFramesOpt = 80,
    resolution = 512,
    fps: fpsOverride,
    start,
    end,
    outDir,
    noWhisper = false,
    whisperBackend,
  } = opts;

  const maxFrames = Math.min(maxFramesOpt, 100);
  const warnings: string[] = [];

  // Work directory
  const workDir = outDir
    ? path.resolve(outDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "8gent-watch-"));
  fs.mkdirSync(workDir, { recursive: true });

  // Step 1: Download or resolve local file
  const dl = isUrl(source)
    ? downloadUrl(source, path.join(workDir, "download"))
    : resolveLocal(source);

  // Step 2: Get metadata
  const meta = getMetadata(dl.videoPath);
  const fullDuration = meta.durationSeconds;

  // Parse time range
  const startSec = parseTime(start);
  const endSec = parseTime(end);

  if (startSec != null && startSec < 0) throw new Error("--start must be non-negative");
  if (endSec != null && startSec != null && endSec <= startSec) throw new Error("--end must be greater than --start");
  if (fullDuration > 0 && startSec != null && startSec >= fullDuration) {
    throw new Error(`--start ${startSec}s is past end of video (${fullDuration}s)`);
  }

  const effectiveStart = startSec ?? 0;
  const effectiveEnd = endSec ?? fullDuration;
  const effectiveDuration = Math.max(0, effectiveEnd - effectiveStart);
  const focused = startSec != null || endSec != null;

  // Step 3: Calculate fps budget
  const budget = focused
    ? autoFpsFocus(effectiveDuration, maxFrames)
    : autoFps(effectiveDuration, maxFrames);

  let fps = budget.fps;
  let target = budget.targetFrames;
  if (fpsOverride != null) {
    fps = Math.min(fpsOverride, MAX_FPS);
    target = Math.max(1, Math.round(fps * effectiveDuration));
  }

  // Step 4: Extract frames
  const frames = extractFrames(dl.videoPath, path.join(workDir, "frames"), {
    fps,
    resolution,
    maxFrames,
    startSeconds: startSec,
    endSeconds: endSec,
  });

  // Step 5: Transcribe
  const transcriptResult = await transcribe(
    dl.videoPath,
    dl.subtitlePath,
    workDir,
    { noWhisper, whisperBackend, startSeconds: startSec, endSeconds: endSec }
  );

  // Warnings
  if (!focused && fullDuration > 600) {
    warnings.push(
      `This is a ${Math.floor(fullDuration / 60)}-minute video. Frame coverage is sparse. ` +
      `For better results, re-run with --start and --end to zoom into a specific section.`
    );
  }
  if (transcriptResult.source === "none") {
    warnings.push("No transcript available — proceeding with frames only.");
  }

  return {
    source,
    title: dl.info.title,
    uploader: dl.info.uploader,
    duration: fullDuration,
    durationFormatted: formatTime(fullDuration),
    resolution: meta.width && meta.height ? `${meta.width}x${meta.height}` : undefined,
    codec: meta.codec !== "unknown" ? meta.codec : undefined,

    focused,
    focusRange: focused ? {
      start: formatTime(effectiveStart),
      end: formatTime(effectiveEnd),
      duration: effectiveDuration,
    } : undefined,

    frames: frames.map(f => ({
      path: f.path,
      timestamp: formatTime(f.timestampSeconds),
      timestampSeconds: f.timestampSeconds,
    })),
    frameCount: frames.length,
    fps,
    frameMode: focused ? "focused" : "full",
    frameResolution: resolution,

    transcript: {
      source: transcriptResult.source,
      segmentCount: transcriptResult.segments.length,
      text: transcriptResult.text,
    },

    workDir,
    warnings,
  };
}

/** Format a WatchReport into a markdown report (matches claude-video output format). */
export function formatReport(report: WatchReport): string {
  const lines: string[] = [];

  lines.push("# watch: video report");
  lines.push("");
  lines.push(`- **Source:** ${report.source}`);
  if (report.title) lines.push(`- **Title:** ${report.title}`);
  if (report.uploader) lines.push(`- **Uploader:** ${report.uploader}`);
  lines.push(`- **Duration:** ${report.durationFormatted} (${report.duration.toFixed(1)}s)`);

  if (report.focused && report.focusRange) {
    lines.push(`- **Focus range:** ${report.focusRange.start} → ${report.focusRange.end} (${report.focusRange.duration.toFixed(1)}s)`);
  }
  if (report.resolution) {
    lines.push(`- **Resolution:** ${report.resolution}${report.codec ? ` (${report.codec})` : ""}`);
  }
  lines.push(`- **Frames:** ${report.frameCount} @ ${report.fps.toFixed(3)} fps, ${report.frameMode} mode`);
  lines.push(`- **Frame size:** ${report.frameResolution}px wide`);

  if (report.transcript.segmentCount > 0) {
    const inRange = report.focused ? " in range" : "";
    lines.push(`- **Transcript:** ${report.transcript.segmentCount} segments${inRange} (via ${report.transcript.source})`);
  } else {
    lines.push("- **Transcript:** none available");
  }

  for (const warning of report.warnings) {
    lines.push("");
    lines.push(`> **Warning:** ${warning}`);
  }

  lines.push("");
  lines.push("## Frames");
  lines.push("");
  lines.push(`Frames live at: \`${path.join(report.workDir, "frames")}\``);
  lines.push("");
  lines.push("**Read each frame path below to view the image.** Frames are in chronological order.");
  lines.push("");
  for (const frame of report.frames) {
    lines.push(`- \`${frame.path}\` (t=${frame.timestamp})`);
  }

  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  if (report.transcript.text) {
    lines.push(`_Source: ${report.transcript.source}._`);
    lines.push("");
    lines.push("```");
    lines.push(report.transcript.text);
    lines.push("```");
  } else {
    lines.push("_No transcript available — proceed with frames only._");
  }

  lines.push("");
  lines.push("---");
  lines.push(`_Work dir: \`${report.workDir}\` — delete when done._`);

  return lines.join("\n");
}
