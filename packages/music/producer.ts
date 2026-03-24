/**
 * MusicProducer - Eight's DJ brain.
 *
 * Orchestrates multiple backends (sox synth, Replicate AI, mixer) to produce
 * complete tracks. Thinks in genres, moods, and energy levels.
 *
 * Usage:
 *   const producer = new MusicProducer();
 *   const track = await producer.produce({ genre: "techno", bpm: 128, durationSec: 120 });
 *   producer.play(track);
 *   producer.loop(track);
 */

import { mkdirSync } from "fs";
import { SoxSynth } from "./sox-synth.js";
import { ReplicateBackend } from "./replicate.js";
import { Mixer } from "./mixer.js";
import { Player } from "./player.js";
import { GENRES, type Genre, type Track, type MixConfig, type Layer, type LayerRole } from "./types.js";

const DEFAULT_OUTPUT_DIR = `${process.env.HOME}/.8gent/music`;

export class MusicProducer {
  private synth: SoxSynth;
  private replicate: ReplicateBackend;
  private mixer: Mixer;
  private player: Player;
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = outputDir || DEFAULT_OUTPUT_DIR;
    mkdirSync(this.outputDir, { recursive: true });
    mkdirSync(`${this.outputDir}/layers`, { recursive: true });
    mkdirSync(`${this.outputDir}/tracks`, { recursive: true });

    this.synth = new SoxSynth(`${this.outputDir}/layers`);
    this.replicate = new ReplicateBackend(`${this.outputDir}/tracks`);
    this.mixer = new Mixer(`${this.outputDir}/tracks`);
    this.player = new Player();
  }

  /**
   * Produce a complete track.
   * Strategy: try AI generation first, fall back to layered sox synthesis.
   */
  async produce(config: Partial<MixConfig> = {}): Promise<Track> {
    const genre: Genre = config.genre || "house";
    const genreInfo = GENRES[genre];
    const bpm = config.bpm || Math.round(
      genreInfo.bpmRange[0] + Math.random() * (genreInfo.bpmRange[1] - genreInfo.bpmRange[0])
    );
    const durationSec = config.durationSec || 60;
    const key = config.key || this.randomKey();
    const bars = Math.round((durationSec * bpm) / (60 * 4));
    const mood = config.mood || genreInfo.mood;
    const wantLoop = config.loop !== false;

    const fullConfig: MixConfig = {
      genre, bpm, key, durationSec, mood,
      layers: config.layers || genreInfo.layers,
      loop: wantLoop,
    };

    console.log(`[producer] Producing ${genre} at ${bpm} BPM, key ${key}, ${bars} bars (${durationSec}s)`);
    console.log(`[producer] Mood: ${mood}, Layers: ${fullConfig.layers.join(", ")}`);

    // Strategy 1: Try AI generation via Replicate
    if (this.replicate.available && durationSec <= 30) {
      console.log(`[producer] Trying AI generation via Replicate...`);
      const aiTrack = await this.replicate.generate(fullConfig);
      if (aiTrack) {
        const mastered = this.mixer.master(aiTrack);
        const final = wantLoop ? this.mixer.makeLoop(mastered) : mastered;
        return this.buildTrack(final, genre, bpm, durationSec, [{ name: "ai-full", path: final, role: "full", volume: 1, pan: 0 }]);
      }
    }

    // Strategy 2: Layered sox synthesis (always available, deterministic)
    console.log(`[producer] Using layered sox synthesis...`);
    const layers: Layer[] = [];

    // Determine drum pattern based on genre
    const drumPattern = genre === "drum-and-bass" || genre === "jungle" ? "dnb"
      : genre === "breakbeat" ? "breakbeat"
      : "four-four";

    for (const role of fullConfig.layers) {
      let path: string;
      switch (role) {
        case "drums":
          path = this.synth.generateDrums(bpm, bars, drumPattern);
          layers.push({ name: "drums", path, role: "drums", volume: 0.8, pan: 0 });
          break;
        case "bass":
          path = this.synth.generateBass(bpm, bars, key);
          layers.push({ name: "bass", path, role: "bass", volume: 0.7, pan: 0 });
          break;
        case "melody":
          path = this.synth.generateMelody(bpm, bars, key);
          layers.push({ name: "melody", path, role: "melody", volume: 0.5, pan: 0.2 });
          break;
        case "pad":
          path = this.synth.generatePad(bpm, bars, key);
          layers.push({ name: "pad", path, role: "pad", volume: 0.4, pan: -0.1 });
          break;
        case "fx":
          // Simple delay-based FX from melody
          path = this.synth.generateMelody(bpm, Math.min(bars, 4), key);
          layers.push({ name: "fx", path, role: "fx", volume: 0.2, pan: 0.5 });
          break;
      }
    }

    // Mix all layers
    const trackName = `${genre}-${bpm}bpm-${Date.now()}`;
    const mixed = this.mixer.mixLayers(layers, trackName);
    const mastered = this.mixer.master(mixed);

    // Make loop-friendly if requested
    let final = mastered;
    if (wantLoop) {
      final = this.mixer.makeLoop(mastered);
    }

    // Extend to desired duration if short
    const actualDur = this.getDuration(final);
    if (actualDur > 0 && actualDur < durationSec * 0.8) {
      const repeats = Math.ceil(durationSec / actualDur);
      final = this.mixer.extend(final, repeats);
    }

    return this.buildTrack(final, genre, bpm, durationSec, layers);
  }

  /** Quick produce and play */
  async quickPlay(genre: Genre = "house", durationSec: number = 60): Promise<Track> {
    const track = await this.produce({ genre, durationSec, loop: true });
    this.loop(track);
    return track;
  }

  /** Play a track once */
  play(track: Track): void {
    this.player.play(track.path);
  }

  /** Loop a track */
  loop(track: Track): void {
    this.player.playLoop(track.path);
  }

  /** Stop playback */
  stop(): void {
    this.player.stop();
  }

  /** Get player status */
  get status() {
    return this.player.status;
  }

  /** Convert track to MP3 */
  toMp3(track: Track): string {
    return this.mixer.toMp3(track.path);
  }

  /** Produce a DJ set - multiple tracks in sequence */
  async djSet(genres: Genre[], minutesPerTrack: number = 2): Promise<Track[]> {
    const tracks: Track[] = [];
    for (const genre of genres) {
      const track = await this.produce({
        genre,
        durationSec: minutesPerTrack * 60,
        loop: false,
      });
      tracks.push(track);
    }
    return tracks;
  }

  /** Play a DJ set on loop */
  async playDjSet(tracks: Track[]): Promise<void> {
    for (const track of tracks) {
      this.player.enqueue(track.path);
    }
    await this.player.playQueue();
  }

  private buildTrack(path: string, genre: Genre, bpm: number, durationSec: number, layers: Layer[]): Track {
    return {
      id: `track_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      path,
      genre,
      bpm,
      durationSec,
      layers,
      createdAt: Date.now(),
    };
  }

  private getDuration(path: string): number {
    try {
      const { execSync } = require("child_process");
      return parseFloat(execSync(`soxi -D "${path}"`).toString().trim());
    } catch {
      return 0;
    }
  }

  private randomKey(): string {
    const keys = ["Am", "Cm", "Dm", "Em", "Fm", "Gm", "A", "C", "D", "E", "F", "G"];
    return keys[Math.floor(Math.random() * keys.length)];
  }
}
