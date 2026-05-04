/**
 * Transcription — parse VTT captions or fall back to Whisper API.
 *
 * Strategy:
 * 1. Use native captions from yt-dlp (free, instant)
 * 2. Fall back to Whisper via Groq (preferred) or OpenAI
 * 3. Proceed frames-only if neither available
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  source: "captions" | "whisper-groq" | "whisper-openai" | "none";
  text: string;
}

// ── VTT Parsing ────────────────────────────────────────────

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function parseVttTimestamp(h: string, m: string, s: string, ms: string): number {
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}

export function parseVtt(vttPath: string): TranscriptSegment[] {
  const content = fs.readFileSync(vttPath, "utf-8");
  const segments: TranscriptSegment[] = [];

  for (const block of content.split(/\n\n+/)) {
    const match = TIME_RE.exec(block);
    if (!match) continue;

    const start = parseVttTimestamp(match[1], match[2], match[3], match[4]);
    const end = parseVttTimestamp(match[5], match[6], match[7], match[8]);

    // Extract text: everything after the timestamp line, strip HTML tags
    const lines = block.split("\n");
    const tsLineIdx = lines.findIndex(l => TIME_RE.test(l));
    const textLines = lines.slice(tsLineIdx + 1).filter(Boolean);
    const text = textLines.join(" ").replace(/<[^>]*>/g, "").trim();

    if (text) segments.push({ start, end, text });
  }

  return dedupeSegments(segments);
}

/** Remove rolling duplicates common in YouTube auto-captions. */
function dedupeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length === 0) return segments;

  const result: TranscriptSegment[] = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const curr = segments[i];

    // Skip if text is identical or previous text is a prefix of current
    if (curr.text === prev.text) {
      prev.end = Math.max(prev.end, curr.end);
      continue;
    }
    if (curr.text.startsWith(prev.text)) {
      prev.text = curr.text;
      prev.end = curr.end;
      continue;
    }

    result.push(curr);
  }
  return result;
}

/** Filter segments to a time range. */
export function filterRange(
  segments: TranscriptSegment[],
  start: number | null,
  end: number | null
): TranscriptSegment[] {
  return segments.filter(s => {
    if (start != null && s.end < start) return false;
    if (end != null && s.start > end) return false;
    return true;
  });
}

/** Format segments into a readable timestamped transcript. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments.map(s => {
    const m = Math.floor(s.start / 60);
    const sec = Math.floor(s.start % 60);
    return `[${m}:${String(sec).padStart(2, "0")}] ${s.text}`;
  }).join("\n");
}

// ── Whisper Fallback ───────────────────────────────────────

export interface WhisperConfig {
  backend: "groq" | "openai";
  apiKey: string;
}

/** Extract audio from video for Whisper upload. Mono 16kHz MP3 at 64kbps (~480KB/min). */
export function extractAudio(videoPath: string, audioPath: string): void {
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  execSync(
    `ffmpeg -v quiet -i "${videoPath}" -vn -ac 1 -ar 16000 -b:a 64k "${audioPath}"`,
    { timeout: 120_000 }
  );
}

/** Load Whisper API key from env or config file. */
export function loadWhisperConfig(preferred?: "groq" | "openai"): WhisperConfig | null {
  // Check environment first
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Check config file
  const configPath = path.join(process.env.HOME || "~", ".config", "watch", ".env");
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    for (const line of content.split("\n")) {
      const [key, ...val] = line.split("=");
      const value = val.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "GROQ_API_KEY" && !groqKey) process.env.GROQ_API_KEY = value;
      if (key.trim() === "OPENAI_API_KEY" && !openaiKey) process.env.OPENAI_API_KEY = value;
    }
  }

  const finalGroq = process.env.GROQ_API_KEY;
  const finalOpenai = process.env.OPENAI_API_KEY;

  if (preferred === "groq" && finalGroq) return { backend: "groq", apiKey: finalGroq };
  if (preferred === "openai" && finalOpenai) return { backend: "openai", apiKey: finalOpenai };
  if (finalGroq) return { backend: "groq", apiKey: finalGroq };
  if (finalOpenai) return { backend: "openai", apiKey: finalOpenai };

  return null;
}

/** Call Whisper API to transcribe audio. */
export async function whisperTranscribe(
  audioPath: string,
  config: WhisperConfig
): Promise<TranscriptSegment[]> {
  const audioData = fs.readFileSync(audioPath);
  const boundary = `----8gentBoundary${Date.now()}`;
  const filename = path.basename(audioPath);

  const model = config.backend === "groq" ? "whisper-large-v3" : "whisper-1";
  const baseUrl = config.backend === "groq"
    ? "https://api.groq.com/openai/v1"
    : "https://api.openai.com/v1";

  // Build multipart body
  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };
  addField("model", model);
  addField("response_format", "verbose_json");
  addField("timestamp_granularities[]", "segment");

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
  ));
  parts.push(audioData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const result = await response.json() as any;

  // Parse segments from verbose_json response
  const segments: TranscriptSegment[] = [];
  if (result.segments) {
    for (const seg of result.segments) {
      segments.push({
        start: seg.start,
        end: seg.end,
        text: seg.text?.trim() || "",
      });
    }
  } else if (result.text) {
    segments.push({ start: 0, end: 0, text: result.text });
  }

  return segments;
}

/** Full transcription pipeline: try captions, fall back to Whisper. */
export async function transcribe(
  videoPath: string,
  subtitlePath: string | null,
  workDir: string,
  opts?: {
    noWhisper?: boolean;
    whisperBackend?: "groq" | "openai";
    startSeconds?: number | null;
    endSeconds?: number | null;
  }
): Promise<TranscriptResult> {
  const { noWhisper, whisperBackend, startSeconds, endSeconds } = opts || {};
  const focused = startSeconds != null || endSeconds != null;

  // Try native captions first
  if (subtitlePath && fs.existsSync(subtitlePath)) {
    try {
      let segments = parseVtt(subtitlePath);
      if (focused) segments = filterRange(segments, startSeconds ?? null, endSeconds ?? null);
      return {
        segments,
        source: "captions",
        text: formatTranscript(segments),
      };
    } catch {
      // Fall through to Whisper
    }
  }

  // Whisper fallback
  if (!noWhisper) {
    const config = loadWhisperConfig(whisperBackend);
    if (config) {
      const audioPath = path.join(workDir, "audio.mp3");
      extractAudio(videoPath, audioPath);
      try {
        let segments = await whisperTranscribe(audioPath, config);
        if (focused) segments = filterRange(segments, startSeconds ?? null, endSeconds ?? null);
        return {
          segments,
          source: config.backend === "groq" ? "whisper-groq" : "whisper-openai",
          text: formatTranscript(segments),
        };
      } catch (err) {
        console.error(`[video] Whisper fallback failed: ${err}`);
      }
    }
  }

  return { segments: [], source: "none", text: "" };
}
