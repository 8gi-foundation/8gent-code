/**
 * Video downloader — wraps yt-dlp for URL downloads and validates local files.
 *
 * Supports YouTube, Vimeo, TikTok, Twitter/X, Twitch, and most yt-dlp sites.
 * Automatically extracts native captions when available.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface DownloadResult {
  videoPath: string;
  subtitlePath: string | null;
  info: {
    title?: string;
    uploader?: string;
    duration?: number;
    url?: string;
  };
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".wmv", ".m4v", ".ts", ".3gp",
]);

export function isUrl(source: string): boolean {
  try {
    const u = new URL(source);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveLocal(filePath: string): DownloadResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    console.warn(`[video] Warning: '${ext}' may not be a recognized video format`);
  }
  return {
    videoPath: resolved,
    subtitlePath: null,
    info: { title: path.basename(resolved) },
  };
}

export function downloadUrl(url: string, outDir: string): DownloadResult {
  fs.mkdirSync(outDir, { recursive: true });

  const cmd = [
    "yt-dlp",
    "--no-playlist",
    "-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
    "--write-subs", "--write-auto-subs",
    "--sub-langs", "en.*,en",
    "--convert-subs", "vtt",
    "--write-info-json",
    "-o", path.join(outDir, "%(id)s.%(ext)s"),
    JSON.stringify(url),
  ].join(" ");

  try {
    execSync(cmd, { stdio: "pipe", timeout: 300_000, encoding: "utf-8" });
  } catch (err: any) {
    // yt-dlp sometimes exits non-zero but still downloads the file
    if (!findVideo(outDir)) {
      throw new Error(`Download failed: ${err.stderr?.slice(0, 500) || err.message}`);
    }
  }

  const videoPath = findVideo(outDir);
  if (!videoPath) throw new Error("Download completed but no video file found");

  const subtitlePath = findSubtitle(outDir);
  const info = loadInfo(outDir);

  return { videoPath, subtitlePath, info };
}

function findVideo(dir: string): string | null {
  const files = fs.readdirSync(dir);
  for (const ext of [".mp4", ".mkv", ".webm", ".mov"]) {
    const found = files.find(f => f.endsWith(ext));
    if (found) return path.join(dir, found);
  }
  // Fallback: any video-like file
  const any = files.find(f => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  return any ? path.join(dir, any) : null;
}

function findSubtitle(dir: string): string | null {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".vtt"));
  // Prefer English
  const en = files.find(f => f.includes(".en.") || f.includes(".en-"));
  return en ? path.join(dir, en) : files[0] ? path.join(dir, files[0]) : null;
}

function loadInfo(dir: string): DownloadResult["info"] {
  const files = fs.readdirSync(dir);
  const jsonFile = files.find(f => f.endsWith(".info.json"));
  if (!jsonFile) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), "utf-8"));
    return {
      title: raw.title || raw.fulltitle,
      uploader: raw.uploader || raw.channel,
      duration: raw.duration,
      url: raw.webpage_url || raw.url,
    };
  } catch {
    return {};
  }
}
