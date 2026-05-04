/**
 * @8gent/video — Video analysis for 8gent Code
 *
 * Download videos from URL or local files, extract frames with adaptive fps,
 * transcribe via native captions or Whisper API, and generate structured reports.
 *
 * Inspired by bradautomates/claude-video, adapted for 8gent's TypeScript/Bun stack.
 *
 * ## Tools
 *
 * | Tool | Description |
 * |------|-------------|
 * | `watch_video` | Full pipeline: download → frames → transcribe → report |
 * | `video_metadata` | Quick metadata probe (duration, resolution, codec) |
 * | `video_frames` | Extract frames only with adaptive fps budgeting |
 * | `video_transcribe` | Transcribe via captions or Whisper (Groq/OpenAI) |
 * | `video_check_deps` | Verify/install yt-dlp, ffmpeg, ffprobe |
 *
 * ## Usage
 *
 * ```typescript
 * // Register all tools
 * import "@8gent/video";
 *
 * // Or use directly
 * import { watch, formatReport } from "@8gent/video/watch";
 * const report = await watch({ source: "https://youtu.be/abc" });
 * console.log(formatReport(report));
 * ```
 */

// Register all video tools with the toolshed
import "./tools";

// Re-export for direct usage
export { watch, formatReport } from "./watch";
export type { WatchOptions, WatchReport } from "./watch";
export { checkDeps, installDeps } from "./deps";
export { getMetadata, extractFrames, autoFps, autoFpsFocus, formatTime, parseTime } from "./frames";
export { transcribe, parseVtt, formatTranscript, loadWhisperConfig } from "./transcribe";
export { isUrl, downloadUrl, resolveLocal } from "./download";
