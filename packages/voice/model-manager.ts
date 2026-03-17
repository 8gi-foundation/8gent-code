/**
 * @8gent/voice — Whisper Model Manager
 *
 * Downloads, lists, and selects Whisper GGML model files.
 * Models are stored in ~/.8gent/models/whisper/ by default.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
import {
  WHISPER_MODELS,
  type WhisperModelName,
  type WhisperModelInfo,
} from "./types.js";

export interface ModelManagerEvents {
  "download-start": [{ model: WhisperModelName; size: number }];
  "download-progress": [{ model: WhisperModelName; percent: number; bytesDownloaded: number; bytesTotal: number }];
  "download-complete": [{ model: WhisperModelName; path: string }];
  "download-error": [{ model: WhisperModelName; message: string }];
}

/**
 * Resolve the models directory path, expanding ~ to homedir.
 */
export function resolveModelsPath(configPath: string): string {
  if (configPath.startsWith("~")) {
    return join(homedir(), configPath.slice(1));
  }
  return configPath;
}

/**
 * Manages Whisper GGML model files.
 */
export class WhisperModelManager extends EventEmitter<ModelManagerEvents> {
  private modelsDir: string;

  constructor(modelsPath: string = "~/.8gent/models/whisper") {
    super();
    this.modelsDir = resolveModelsPath(modelsPath);
  }

  /**
   * Ensure the models directory exists.
   */
  ensureModelsDir(): void {
    if (!existsSync(this.modelsDir)) {
      mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Get the directory where models are stored.
   */
  getModelsDir(): string {
    return this.modelsDir;
  }

  /**
   * Get info about a specific model.
   */
  getModelInfo(name: WhisperModelName): WhisperModelInfo {
    return WHISPER_MODELS[name];
  }

  /**
   * Get the local file path for a model (whether or not it's downloaded).
   */
  getModelPath(name: WhisperModelName): string {
    return join(this.modelsDir, WHISPER_MODELS[name].filename);
  }

  /**
   * Check if a model is downloaded locally.
   */
  isModelDownloaded(name: WhisperModelName): boolean {
    return existsSync(this.getModelPath(name));
  }

  /**
   * List all available models with download status.
   */
  listModels(): Array<WhisperModelInfo & { downloaded: boolean; localPath: string }> {
    return (Object.keys(WHISPER_MODELS) as WhisperModelName[]).map((name) => ({
      ...WHISPER_MODELS[name],
      downloaded: this.isModelDownloaded(name),
      localPath: this.getModelPath(name),
    }));
  }

  /**
   * List only downloaded models.
   */
  getDownloadedModels(): WhisperModelName[] {
    return (Object.keys(WHISPER_MODELS) as WhisperModelName[]).filter((name) =>
      this.isModelDownloaded(name)
    );
  }

  /**
   * Download a Whisper model with progress reporting.
   *
   * @returns The local path to the downloaded model file.
   */
  async downloadModel(name: WhisperModelName): Promise<string> {
    const info = WHISPER_MODELS[name];
    const destPath = this.getModelPath(name);

    // Already downloaded?
    if (existsSync(destPath)) {
      return destPath;
    }

    this.ensureModelsDir();
    this.emit("download-start", { model: name, size: info.size });

    try {
      const response = await fetch(info.url, {
        headers: {
          "User-Agent": "8gent-code/0.5.0",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get("content-length") || info.size);
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("No response body");
      }

      const chunks: Uint8Array[] = [];
      let bytesDownloaded = 0;
      let lastEmitTime = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        bytesDownloaded += value.length;

        // Emit progress at most every 200ms to avoid flooding
        const now = Date.now();
        if (now - lastEmitTime > 200 || bytesDownloaded === contentLength) {
          lastEmitTime = now;
          const percent = Math.round((bytesDownloaded / contentLength) * 100);
          this.emit("download-progress", {
            model: name,
            percent,
            bytesDownloaded,
            bytesTotal: contentLength,
          });
        }
      }

      // Concatenate chunks and write to file
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const fullBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      await Bun.write(destPath, fullBuffer);

      this.emit("download-complete", { model: name, path: destPath });
      return destPath;

    } catch (err) {
      // Clean up partial download
      if (existsSync(destPath)) {
        try { unlinkSync(destPath); } catch { /* ignore */ }
      }

      const message = err instanceof Error ? err.message : "Download failed";
      this.emit("download-error", { model: name, message });
      throw new Error(`Failed to download Whisper model '${name}': ${message}`);
    }
  }

  /**
   * Delete a downloaded model to free disk space.
   */
  deleteModel(name: WhisperModelName): boolean {
    const path = this.getModelPath(name);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }

  /**
   * Get total disk usage of downloaded models.
   */
  getDiskUsage(): { totalBytes: number; models: Record<string, number> } {
    const models: Record<string, number> = {};
    let totalBytes = 0;

    for (const name of Object.keys(WHISPER_MODELS) as WhisperModelName[]) {
      const path = this.getModelPath(name);
      if (existsSync(path)) {
        try {
          const stat = Bun.file(path);
          models[name] = stat.size;
          totalBytes += stat.size;
        } catch {
          // skip
        }
      }
    }

    return { totalBytes, models };
  }
}
