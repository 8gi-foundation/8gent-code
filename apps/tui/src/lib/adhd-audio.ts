/**
 * 8gent Code - ADHD Mode Audio
 *
 * Generates and plays focus audio via ACE-Step (local music gen).
 * Optional — only works if ACE-Step API server is running on localhost:8001.
 *
 * Usage:
 *   const audio = new ADHDAudio();
 *   await audio.play("lofi");       // Generate & loop a lofi track
 *   await audio.play("rainsound");  // Generate & loop rain sounds
 *   await audio.play("whitenoise"); // Generate & loop white noise
 *   audio.stop();                   // Stop playback
 *   audio.config;                   // Get current config
 *   audio.setConfig({ duration: 120, bpm: 80 }); // Override settings
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ============================================
// Types
// ============================================

export type ADHDSoundscape = "lofi" | "rainsound" | "whitenoise" | "ambient" | "classical";

interface SoundscapePreset {
  prompt: string;
  lyrics: string;
  duration: number;
  bpm?: number;
}

/** User-configurable generation settings */
export interface ADHDAudioConfig {
  /** Duration in seconds (5-600, default 60) */
  duration: number;
  /** BPM override (null = use preset default) */
  bpm: number | null;
  /** Inference steps (1-50, default 8). More = better quality, slower */
  inferenceSteps: number;
  /** Guidance scale (1-15, default 7). Higher = more prompt adherence */
  guidanceScale: number;
  /** ACE-Step API URL */
  apiUrl: string;
  /** Batch size (1-4, default 1) */
  batchSize: number;
}

const DEFAULT_CONFIG: ADHDAudioConfig = {
  duration: 180,
  bpm: null,
  inferenceSteps: 8,
  guidanceScale: 7.0,
  apiUrl: "http://localhost:8001",
  batchSize: 1,
};

// ============================================
// Soundscape Presets
// ============================================

const SOUNDSCAPES: Record<ADHDSoundscape, SoundscapePreset> = {
  lofi: {
    prompt: "lofi hip hop beat, chill, ambient, warm vinyl crackle, mellow piano chords, soft drums, study music, relaxing, instrumental",
    lyrics: "[instrumental]",
    duration: 60,
    bpm: 75,
  },
  rainsound: {
    prompt: "gentle rain falling on a window, soft thunder in the distance, ambient rain sounds, nature soundscape, peaceful, calming",
    lyrics: "[instrumental]",
    duration: 60,
  },
  whitenoise: {
    prompt: "white noise, soft static, ambient drone, consistent gentle hum, focus sound, minimal, meditative",
    lyrics: "[instrumental]",
    duration: 60,
  },
  ambient: {
    prompt: "ambient electronic music, soft synthesizer pads, ethereal textures, floating, spacious, Brian Eno style, instrumental",
    lyrics: "[instrumental]",
    duration: 60,
    bpm: 60,
  },
  classical: {
    prompt: "soft classical piano, gentle and contemplative, Erik Satie style, minimalist, peaceful, solo piano instrumental",
    lyrics: "[instrumental]",
    duration: 60,
    bpm: 70,
  },
};

// ============================================
// Config persistence
// ============================================

const CACHE_DIR = join(process.env.HOME || "~", ".8gent", "adhd-audio");
const CONFIG_PATH = join(CACHE_DIR, "config.json");

function loadConfig(): ADHDAudioConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(require("fs").readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: ADHDAudioConfig): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch { /* silent */ }
}

// ============================================
// ADHD Audio Manager
// ============================================

export class ADHDAudio {
  private playerProcess: Subprocess | null = null;
  private currentSoundscape: ADHDSoundscape | null = null;
  private generating = false;
  private _config: ADHDAudioConfig;

  constructor() {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    this._config = loadConfig();
  }

  /** Get current config */
  get config(): ADHDAudioConfig {
    return { ...this._config };
  }

  /** Update config (merges with existing). Clears cache if duration/bpm changed. */
  setConfig(overrides: Partial<ADHDAudioConfig>): ADHDAudioConfig {
    const durationChanged = overrides.duration !== undefined && overrides.duration !== this._config.duration;
    const bpmChanged = overrides.bpm !== undefined && overrides.bpm !== this._config.bpm;
    const stepsChanged = overrides.inferenceSteps !== undefined && overrides.inferenceSteps !== this._config.inferenceSteps;

    this._config = { ...this._config, ...overrides };

    // Clamp values
    this._config.duration = Math.max(5, Math.min(600, this._config.duration));
    this._config.inferenceSteps = Math.max(1, Math.min(50, this._config.inferenceSteps));
    this._config.guidanceScale = Math.max(1, Math.min(15, this._config.guidanceScale));
    this._config.batchSize = Math.max(1, Math.min(4, this._config.batchSize));

    saveConfig(this._config);

    // Clear cached audio if generation params changed
    if (durationChanged || bpmChanged || stepsChanged) {
      this.clearCache();
    }

    return this.config;
  }

  /** Clear all cached audio (forces regeneration) */
  clearCache(): void {
    for (const soundscape of Object.keys(SOUNDSCAPES) as ADHDSoundscape[]) {
      const path = this.getCachePath(soundscape);
      try { if (existsSync(path)) require("fs").unlinkSync(path); } catch { /* ok */ }
    }
  }

  /** Check if ACE-Step API is available */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this._config.apiUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private getCachePath(soundscape: ADHDSoundscape): string {
    return join(CACHE_DIR, `${soundscape}.mp3`);
  }

  private hasCached(soundscape: ADHDSoundscape): boolean {
    return existsSync(this.getCachePath(soundscape));
  }

  /** Generate audio via ACE-Step API */
  private async generate(soundscape: ADHDSoundscape): Promise<string | null> {
    const preset = SOUNDSCAPES[soundscape];
    if (!preset) return null;

    this.generating = true;

    // User config overrides preset defaults
    const duration = this._config.duration;
    const bpm = this._config.bpm ?? preset.bpm ?? null;

    try {
      const res = await fetch(`${this._config.apiUrl}/release_task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: preset.prompt,
          lyrics: preset.lyrics,
          audio_duration: duration,
          bpm,
          inference_steps: this._config.inferenceSteps,
          guidance_scale: this._config.guidanceScale,
          use_random_seed: true,
          task_type: "text2music",
          batch_size: this._config.batchSize,
          // Skip LM — DiT-only for fast gen on macOS/MPS
          thinking: false,
          use_cot_caption: false,
          use_cot_language: false,
        }),
      });

      if (!res.ok) return null;

      const data = await res.json() as { data?: { task_id?: string } };
      const taskId = data.data?.task_id;
      if (!taskId) return null;

      const outputPath = await this.pollResult(taskId);
      if (!outputPath) return null;

      const cachePath = this.getCachePath(soundscape);
      const audioUrl = outputPath.startsWith("http") ? outputPath : `${this._config.apiUrl}${outputPath}`;
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) return null;

      const audioBuffer = await audioRes.arrayBuffer();
      await Bun.write(cachePath, audioBuffer);

      return cachePath;
    } catch {
      return null;
    } finally {
      this.generating = false;
    }
  }

  /** Poll ACE-Step for task completion */
  private async pollResult(taskId: string, maxWait = 300000): Promise<string | null> {
    const start = Date.now();
    const interval = 2000;

    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(`${this._config.apiUrl}/query_result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task_id_list: [taskId] }),
        });

        if (res.ok) {
          const data = await res.json() as {
            data?: Array<{ task_id: string; result: string; status: number }>;
          };
          const job = data.data?.[0];

          if (job && job.status === 1) {
            const results = JSON.parse(job.result) as Array<{ file?: string; status?: number }>;
            const audioUrl = results?.[0]?.file;
            if (audioUrl) return audioUrl;
          }
          if (job && job.status === 2) return null;
        }
      } catch { /* keep polling */ }

      await Bun.sleep(interval);
    }

    return null;
  }

  /** Play audio file on loop using afplay (macOS) */
  private startPlayback(filePath: string): void {
    this.stopPlayback();

    const loop = () => {
      if (!this.currentSoundscape) return;

      this.playerProcess = spawn(["afplay", filePath], {
        stdout: "ignore",
        stderr: "ignore",
        onExit: () => {
          if (this.currentSoundscape) loop();
        },
      });
    };

    loop();
  }

  private stopPlayback(): void {
    if (this.playerProcess) {
      this.playerProcess.kill();
      this.playerProcess = null;
    }
  }

  /** Play a soundscape (generates if not cached) */
  async play(soundscape: ADHDSoundscape): Promise<{
    ok: boolean;
    message: string;
    generating?: boolean;
  }> {
    if (!(soundscape in SOUNDSCAPES)) {
      const available = Object.keys(SOUNDSCAPES).join(", ");
      return { ok: false, message: `Unknown soundscape. Available: ${available}` };
    }

    this.stop();
    this.currentSoundscape = soundscape;

    if (this.hasCached(soundscape)) {
      this.startPlayback(this.getCachePath(soundscape));
      return { ok: true, message: `Playing ${soundscape} (${this._config.duration}s loop). /adhd stop to end.` };
    }

    const available = await this.isAvailable();
    if (!available) {
      this.currentSoundscape = null;
      return {
        ok: false,
        message: "ACE-Step isn't running. Start it with:\n  cd ~/ace-step/ace-step-1.5 && uv run --frozen python -m uvicorn acestep.api_server:app --host 0.0.0.0 --port 8001 --workers 1\n\nThen try again.",
      };
    }

    const genPromise = this.generate(soundscape);
    genPromise.then((path) => {
      if (path && this.currentSoundscape === soundscape) {
        this.startPlayback(path);
      }
    });

    return {
      ok: true,
      message: `Generating ${soundscape} (${this._config.duration}s)... It'll start playing when ready.`,
      generating: true,
    };
  }

  /** Stop all audio */
  stop(): void {
    this.currentSoundscape = null;
    this.stopPlayback();
  }

  get isPlaying(): boolean {
    return this.currentSoundscape !== null;
  }

  get isGenerating(): boolean {
    return this.generating;
  }

  get current(): ADHDSoundscape | null {
    return this.currentSoundscape;
  }

  static get soundscapes(): ADHDSoundscape[] {
    return Object.keys(SOUNDSCAPES) as ADHDSoundscape[];
  }
}

// Singleton
let instance: ADHDAudio | null = null;

export function getADHDAudio(): ADHDAudio {
  if (!instance) {
    instance = new ADHDAudio();
  }
  return instance;
}
