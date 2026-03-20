/**
 * Local TTS Client — lightweight integration for local voice synthesis servers
 *
 * If a local TTS server is running (localhost:8000), use it for:
 * 1. Voice cloning from an audio sample
 * 2. High-quality TTS generation
 *
 * Compatible with any server that implements:
 *   POST /generate { text, profile_id, language }
 *   GET  /profiles
 *   POST /profiles { name, language }
 *   POST /profiles/:id/samples (multipart audio upload)
 *
 * Compatible with any server implementing this API
 * If not available, falls back to macOS `say` command.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

const TTS_SERVER_URL = process.env.TTS_SERVER_URL || "http://localhost:8000";

/** Check if local TTS server is available */
export async function isLocalTTSAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${TTS_SERVER_URL}/profiles`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Clone a voice from an audio file. Returns the profile ID. */
export async function cloneVoice(
  audioPath: string,
  name: string,
  language = "en"
): Promise<{ profileId: string; name: string } | null> {
  if (!existsSync(audioPath)) {
    console.error(`Audio file not found: ${audioPath}`);
    return null;
  }

  if (!(await isLocalTTSAvailable())) {
    console.error(`Local TTS server not running at ${TTS_SERVER_URL}`);
    return null;
  }

  // Create profile
  const profileRes = await fetch(`${TTS_SERVER_URL}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, language }),
  });

  if (!profileRes.ok) {
    console.error(`Failed to create profile: ${profileRes.status}`);
    return null;
  }

  const profile = (await profileRes.json()) as { id: string; name: string };

  // Upload audio sample
  const audioData = readFileSync(audioPath);
  const form = new FormData();
  form.append("audio", new Blob([audioData]), "sample.wav");
  form.append("reference_text", "");

  const sampleRes = await fetch(`${TTS_SERVER_URL}/profiles/${profile.id}/samples`, {
    method: "POST",
    body: form,
  });

  if (!sampleRes.ok) {
    console.error(`Failed to upload sample: ${sampleRes.status}`);
    return null;
  }

  return { profileId: profile.id, name: profile.name };
}

/** Generate speech via local TTS server. Returns audio buffer. */
export async function generateSpeech(
  text: string,
  profileId: string
): Promise<Buffer | null> {
  if (!(await isLocalTTSAvailable())) return null;

  const res = await fetch(`${TTS_SERVER_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, profile_id: profileId, language: "en" }),
  });

  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** List available voice profiles */
export async function listProfiles(): Promise<Array<{ id: string; name: string }>> {
  if (!(await isLocalTTSAvailable())) return [];
  try {
    const res = await fetch(`${TTS_SERVER_URL}/profiles`);
    return (await res.json()) as Array<{ id: string; name: string }>;
  } catch {
    return [];
  }
}

/**
 * Speak text using the best available method:
 * 1. Local TTS (if running + profile set)
 * 2. macOS say (with selected voice)
 */
export async function speak(
  text: string,
  options: { ttsProfileId?: string; systemVoice?: string } = {}
): Promise<void> {
  // Try local TTS server first
  if (options.ttsProfileId) {
    const audio = await generateSpeech(text, options.ttsProfileId);
    if (audio) {
      // Play the audio buffer
      const tmpPath = `/tmp/8gent-tts-${Date.now()}.wav`;
      require("fs").writeFileSync(tmpPath, audio);
      try {
        execSync(`afplay "${tmpPath}"`, { stdio: "pipe" });
      } finally {
        try { require("fs").unlinkSync(tmpPath); } catch {}
      }
      return;
    }
  }

  // Fallback to macOS say
  const voice = options.systemVoice || "Moira";
  const safe = text.replace(/"/g, '\\"').slice(0, 500);
  try {
    execSync(`say -v "${voice}" "${safe}"`, { stdio: "pipe", timeout: 30000 });
  } catch {
    // Last resort — default voice
    execSync(`say "${safe}"`, { stdio: "pipe", timeout: 30000 });
  }
}
