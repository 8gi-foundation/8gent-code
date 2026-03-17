/**
 * @8gent/voice — Cloud Transcriber (OpenAI Whisper API)
 *
 * Fallback transcription using the OpenAI /v1/audio/transcriptions endpoint.
 * Used when local whisper.cpp is not available or user prefers cloud mode.
 */

import { existsSync } from "fs";
import type { TranscriptEvent } from "./types.js";

export interface CloudTranscriberOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (default: "whisper-1") */
  model?: string;
  /** Transcription language (ISO 639-1, default: "en") */
  language?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** API base URL (default: OpenAI) */
  baseUrl?: string;
}

/**
 * Transcribe a WAV file using the OpenAI Whisper API.
 *
 * @param wavPath Path to the WAV file
 * @param options Cloud transcriber configuration
 * @returns TranscriptEvent with the transcribed text
 */
export async function transcribeCloud(
  wavPath: string,
  options: CloudTranscriberOptions,
): Promise<TranscriptEvent> {
  const {
    apiKey,
    model = "whisper-1",
    language = "en",
    timeoutMs = 30000,
    baseUrl = "https://api.openai.com/v1",
  } = options;

  if (!apiKey) {
    throw new Error("OpenAI API key is required for cloud transcription. Set OPENAI_API_KEY environment variable.");
  }

  if (!existsSync(wavPath)) {
    throw new Error(`WAV file not found: ${wavPath}`);
  }

  const startTime = Date.now();

  // Read the WAV file
  const wavFile = Bun.file(wavPath);
  const wavSize = wavFile.size;

  // Estimate audio duration (16kHz, 16-bit, mono = 32000 bytes/sec)
  const audioDurationMs = Math.round(((wavSize - 44) / 32000) * 1000);

  // Build multipart form data
  const formData = new FormData();
  formData.append("file", wavFile, "recording.wav");
  formData.append("model", model);
  formData.append("language", language);
  formData.append("response_format", "json");

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${errorBody || response.statusText}`);
    }

    const result = await response.json() as { text: string };
    const durationMs = Date.now() - startTime;

    return {
      text: result.text.trim(),
      isFinal: true,
      durationMs,
      model: "cloud",
      audioDurationMs,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Cloud transcription timed out after ${timeoutMs}ms`);
    }

    throw err;
  }
}

/**
 * Check if cloud transcription is available (API key is set).
 */
export function isCloudAvailable(apiKey?: string): boolean {
  const key = apiKey || process.env.OPENAI_API_KEY;
  return Boolean(key && key.length > 0);
}

/**
 * Get the OpenAI API key from options or environment.
 */
export function getApiKey(configKey?: string): string | null {
  return configKey || process.env.OPENAI_API_KEY || null;
}
