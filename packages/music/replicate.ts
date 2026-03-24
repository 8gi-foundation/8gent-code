/**
 * ReplicateBackend - AI music generation via Replicate API.
 *
 * Uses MusicGen (Meta) for high-quality AI-composed music.
 * Falls back to local sox synthesis if API is unavailable.
 */

import { mkdirSync } from "fs";
import type { Genre, LayerRole, MixConfig } from "./types.js";

const REPLICATE_API = "https://api.replicate.com/v1/predictions";

// MusicGen model on Replicate
const MUSICGEN_MODEL = "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055f2a91c1c7c6b372394a788";

export class ReplicateBackend {
  private apiKey: string | null;
  private outputDir: string;

  constructor(outputDir: string) {
    this.apiKey = process.env.REPLICATE_API_KEY || null;
    this.outputDir = outputDir;
    mkdirSync(outputDir, { recursive: true });
  }

  get available(): boolean {
    return this.apiKey !== null;
  }

  /** Generate a full track via MusicGen */
  async generate(config: MixConfig): Promise<string | null> {
    if (!this.apiKey) return null;

    const prompt = this.buildPrompt(config);
    console.log(`[music/replicate] Generating: ${prompt.slice(0, 80)}...`);

    try {
      // Create prediction
      const createRes = await fetch(REPLICATE_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: MUSICGEN_MODEL.split(":")[1],
          input: {
            prompt,
            duration: Math.min(config.durationSec, 30), // MusicGen max 30s
            model_version: "stereo-melody-large",
            output_format: "wav",
            normalization_strategy: "peak",
          },
        }),
      });

      if (!createRes.ok) {
        console.log(`[music/replicate] API error: ${createRes.status}`);
        return null;
      }

      const prediction = await createRes.json() as any;
      const predictionId = prediction.id;

      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));

        const pollRes = await fetch(`${REPLICATE_API}/${predictionId}`, {
          headers: { "Authorization": `Bearer ${this.apiKey}` },
        });
        const status = await pollRes.json() as any;

        if (status.status === "succeeded" && status.output) {
          // Download the audio file
          const audioUrl = status.output;
          const audioRes = await fetch(audioUrl);
          const audioBuffer = await audioRes.arrayBuffer();

          const outPath = `${this.outputDir}/replicate-${Date.now()}.wav`;
          await Bun.write(outPath, audioBuffer);
          console.log(`[music/replicate] Generated: ${outPath}`);
          return outPath;
        }

        if (status.status === "failed") {
          console.log(`[music/replicate] Generation failed: ${status.error}`);
          return null;
        }
      }

      console.log(`[music/replicate] Timeout waiting for generation`);
      return null;
    } catch (err) {
      console.log(`[music/replicate] Error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Build a descriptive prompt for MusicGen */
  private buildPrompt(config: MixConfig): string {
    const genreDescriptions: Partial<Record<Genre, string>> = {
      techno: "driving four-on-the-floor techno with pulsating synthesizers and deep rolling bassline",
      house: "groovy deep house with warm chords, shuffling hi-hats, and soulful progression",
      minimal: "hypnotic minimal techno with sparse percussion, subtle modulation, and deep sub bass",
      ambient: "atmospheric ambient soundscape with evolving textures and ethereal pads",
      "drum-and-bass": "energetic drum and bass with fast breakbeats and heavy sub bass",
      breakbeat: "funky breakbeat with chopped drums, fat bass, and syncopated rhythms",
      trance: "euphoric trance with arpeggiated synths, building energy, and soaring lead melody",
      lofi: "warm lofi hip hop beats with vinyl crackle, jazzy chords, and mellow drums",
      synthwave: "retro synthwave with analog synths, gated reverb drums, and nostalgic melody",
      electro: "aggressive electro with distorted bass, sharp synths, and driving rhythm",
      dub: "spacious dub with heavy delay, reverb-drenched percussion, and deep bassline",
      downtempo: "relaxed downtempo with organic drums, warm bass, and gentle melodies",
      idm: "experimental electronic music with glitchy rhythms and unusual sound design",
    };

    const desc = genreDescriptions[config.genre] || `${config.genre} electronic music`;
    const moodStr = config.mood ? `, ${config.mood} mood` : "";
    const bpmStr = `${config.bpm} BPM`;
    const keyStr = config.key ? `, key of ${config.key}` : "";

    return `${desc}${moodStr}, ${bpmStr}${keyStr}, instrumental, high quality production, no vocals`;
  }
}
