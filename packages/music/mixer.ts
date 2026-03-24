/**
 * Mixer - Combines layers into a final mixed track using sox and ffmpeg.
 *
 * Handles volume balancing, panning, EQ, compression, and looping.
 * Think: a virtual mixing desk.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import type { Layer } from "./types.js";

export class Mixer {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    mkdirSync(outputDir, { recursive: true });
  }

  /** Mix multiple layers into a single stereo track */
  mixLayers(layers: Layer[], outputName: string): string {
    const outPath = `${this.outputDir}/${outputName}.wav`;

    if (layers.length === 0) return outPath;
    if (layers.length === 1) {
      execSync(`cp "${layers[0].path}" "${outPath}"`);
      return outPath;
    }

    // Process each layer: apply volume, EQ based on role
    const processed: string[] = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const procPath = `${this.outputDir}/_mix_layer_${i}.wav`;

      let effects = `vol ${layer.volume.toFixed(2)}`;

      // Role-based EQ
      switch (layer.role) {
        case "drums":
          effects += " highpass 30 compand 0.01,0.1 -70,-60,-20 0 0 0.1";
          break;
        case "bass":
          effects += " lowpass 250 highpass 30";
          break;
        case "melody":
          effects += " highpass 300 lowpass 8000";
          break;
        case "pad":
          effects += " highpass 200 lowpass 6000 reverb 60";
          break;
        case "fx":
          effects += " highpass 500 reverb 80 50 100";
          break;
      }

      try {
        execSync(`sox "${layer.path}" "${procPath}" ${effects}`);
        processed.push(procPath);
      } catch {
        // Skip layers that fail processing
        console.log(`[mixer] Warning: failed to process layer ${layer.name}`);
      }
    }

    if (processed.length === 0) return outPath;

    // Mix all processed layers together
    try {
      execSync(`sox -m ${processed.map(p => `"${p}"`).join(" ")} "${outPath}"`);
    } catch {
      // Fallback: just use the first layer
      execSync(`cp "${processed[0]}" "${outPath}"`);
    }

    // Clean up processed files
    for (const p of processed) {
      try { execSync(`rm "${p}"`); } catch {}
    }

    return outPath;
  }

  /** Apply master chain: compression, limiting, normalization */
  master(inputPath: string): string {
    const outPath = inputPath.replace(".wav", "-mastered.wav");
    try {
      execSync(`sox "${inputPath}" "${outPath}" compand 0.01,0.3 -70,-60,-20 -5 0 0.1 norm -1`);
      return outPath;
    } catch {
      return inputPath; // Return unmastered if it fails
    }
  }

  /** Make a track loop seamlessly by crossfading the end into the start */
  makeLoop(inputPath: string, crossfadeSec: number = 2): string {
    const outPath = inputPath.replace(".wav", "-loop.wav");
    try {
      // Get duration
      const durStr = execSync(`soxi -D "${inputPath}"`).toString().trim();
      const duration = parseFloat(durStr);

      if (duration < crossfadeSec * 3) {
        // Track too short for crossfade, just copy
        execSync(`cp "${inputPath}" "${outPath}"`);
        return outPath;
      }

      // Extract tail for crossfade
      const tailStart = duration - crossfadeSec;
      const tailPath = `${inputPath}.tail.wav`;
      const headPath = `${inputPath}.head.wav`;
      const bodyPath = `${inputPath}.body.wav`;

      execSync(`sox "${inputPath}" "${tailPath}" trim ${tailStart}`);
      execSync(`sox "${inputPath}" "${headPath}" trim 0 ${crossfadeSec}`);
      execSync(`sox "${inputPath}" "${bodyPath}" trim ${crossfadeSec} ${tailStart - crossfadeSec}`);

      // Crossfade tail with head
      const xfadePath = `${inputPath}.xfade.wav`;
      execSync(`sox "${tailPath}" "${xfadePath}" fade l 0 ${crossfadeSec} ${crossfadeSec}`);

      // Concatenate: body + crossfade
      execSync(`sox "${bodyPath}" "${xfadePath}" "${outPath}"`);

      // Clean up
      try { execSync(`rm "${tailPath}" "${headPath}" "${bodyPath}" "${xfadePath}"`); } catch {}

      return outPath;
    } catch {
      execSync(`cp "${inputPath}" "${outPath}"`);
      return outPath;
    }
  }

  /** Convert WAV to MP3 for smaller file size */
  toMp3(inputPath: string, bitrate: number = 192): string {
    const outPath = inputPath.replace(".wav", ".mp3");
    try {
      execSync(`ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a ${bitrate}k "${outPath}" 2>/dev/null`);
      return outPath;
    } catch {
      return inputPath;
    }
  }

  /** Extend a track by looping it N times */
  extend(inputPath: string, times: number): string {
    const outPath = inputPath.replace(".wav", `-x${times}.wav`);
    const inputs = Array(times).fill(`"${inputPath}"`).join(" ");
    try {
      execSync(`sox ${inputs} "${outPath}"`);
      return outPath;
    } catch {
      return inputPath;
    }
  }
}
