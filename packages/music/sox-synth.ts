/**
 * SoxSynth - Deterministic music synthesis using sox (Sound eXchange).
 *
 * Generates drum patterns, bass lines, melodies, and pads using
 * sox's built-in synth capabilities. No AI needed - pure DSP.
 * This is the "instruments" layer of Eight's music production.
 */

import { execSync } from "child_process";
import { mkdirSync, existsSync } from "fs";
import type { LayerRole } from "./types.js";

const SOX = "sox";
const SAMPLE_RATE = 44100;

export class SoxSynth {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    mkdirSync(outputDir, { recursive: true });
  }

  /** Generate a kick drum hit */
  private kick(path: string): void {
    // Sine wave pitch sweep from 150Hz to 40Hz with quick decay
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${path} synth 0.3 sine 150:40 vol 0.9 fade l 0.005 0.3 0.1`);
  }

  /** Generate a snare hit */
  private snare(path: string): void {
    // Noise burst + sine body
    const noise = `${path}.noise.wav`;
    const body = `${path}.body.wav`;
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${noise} synth 0.15 noise vol 0.4 fade l 0.001 0.15 0.1`);
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${body} synth 0.15 sine 200:120 vol 0.5 fade l 0.001 0.15 0.08`);
    execSync(`${SOX} -m ${noise} ${body} ${path}`);
    try { execSync(`rm ${noise} ${body}`); } catch {}
  }

  /** Generate a closed hi-hat */
  private hihat(path: string): void {
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${path} synth 0.05 noise vol 0.25 highpass 8000 fade l 0.001 0.05 0.03`);
  }

  /** Generate an open hi-hat */
  private openHihat(path: string): void {
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${path} synth 0.2 noise vol 0.2 highpass 6000 fade l 0.001 0.2 0.15`);
  }

  /** Generate a bass note at given frequency */
  private bassNote(path: string, freq: number, duration: number): void {
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${path} synth ${duration} sine ${freq} vol 0.6 fade l 0.01 ${duration} 0.05 lowpass 200`);
  }

  /** Generate a pad chord */
  private padChord(path: string, freqs: number[], duration: number): void {
    const parts = freqs.map((f, i) => {
      const part = `${path}.pad${i}.wav`;
      execSync(`${SOX} -n -r ${SAMPLE_RATE} ${part} synth ${duration} sine ${f} vol ${0.15 / freqs.length} fade l 0.5 ${duration} 1.0`);
      return part;
    });
    execSync(`${SOX} -m ${parts.join(" ")} ${path}`);
    try { execSync(`rm ${parts.join(" ")}`); } catch {}
  }

  /** Generate a melody note */
  private melodyNote(path: string, freq: number, duration: number): void {
    execSync(`${SOX} -n -r ${SAMPLE_RATE} ${path} synth ${duration} square ${freq} vol 0.2 fade l 0.01 ${duration} 0.05 lowpass 3000`);
  }

  /** Build a drum pattern for N bars at given BPM */
  generateDrums(bpm: number, bars: number, pattern: "four-four" | "breakbeat" | "dnb" = "four-four"): string {
    const beatDur = 60 / bpm;
    const barDur = beatDur * 4;
    const totalDur = barDur * bars;
    const outPath = `${this.outputDir}/drums-${Date.now()}.wav`;

    // Generate individual hits
    const kickPath = `${this.outputDir}/_kick.wav`;
    const snarePath = `${this.outputDir}/_snare.wav`;
    const hihatPath = `${this.outputDir}/_hihat.wav`;
    const ohPath = `${this.outputDir}/_openhat.wav`;
    this.kick(kickPath);
    this.snare(snarePath);
    this.hihat(hihatPath);
    this.openHihat(ohPath);

    // Create silence base
    execSync(`${SOX} -n -r ${SAMPLE_RATE} -c 1 ${outPath} trim 0 ${totalDur}`);

    // Place hits according to pattern
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * barDur;

      if (pattern === "four-four") {
        // Kick on 1, 2, 3, 4
        for (let beat = 0; beat < 4; beat++) {
          this.mixAt(outPath, kickPath, barStart + beat * beatDur);
        }
        // Snare on 2, 4
        this.mixAt(outPath, snarePath, barStart + 1 * beatDur);
        this.mixAt(outPath, snarePath, barStart + 3 * beatDur);
        // Hihats on every 8th
        for (let eighth = 0; eighth < 8; eighth++) {
          const hatFile = eighth % 4 === 2 ? ohPath : hihatPath;
          this.mixAt(outPath, hatFile, barStart + eighth * (beatDur / 2));
        }
      } else if (pattern === "breakbeat") {
        // Kick on 1, 2.5
        this.mixAt(outPath, kickPath, barStart);
        this.mixAt(outPath, kickPath, barStart + 1.5 * beatDur);
        // Snare on 2, 4
        this.mixAt(outPath, snarePath, barStart + 1 * beatDur);
        this.mixAt(outPath, snarePath, barStart + 3 * beatDur);
        // Offbeat hihats
        for (let eighth = 0; eighth < 8; eighth++) {
          this.mixAt(outPath, hihatPath, barStart + eighth * (beatDur / 2));
        }
      } else if (pattern === "dnb") {
        // Fast breakbeat pattern
        this.mixAt(outPath, kickPath, barStart);
        this.mixAt(outPath, kickPath, barStart + 2.75 * beatDur);
        this.mixAt(outPath, snarePath, barStart + 1 * beatDur);
        this.mixAt(outPath, snarePath, barStart + 3 * beatDur);
        for (let sixteenth = 0; sixteenth < 16; sixteenth++) {
          if (sixteenth % 2 === 0) {
            this.mixAt(outPath, hihatPath, barStart + sixteenth * (beatDur / 4));
          }
        }
      }
    }

    // Clean up temp files
    try { execSync(`rm ${kickPath} ${snarePath} ${hihatPath} ${ohPath}`); } catch {}

    return outPath;
  }

  /** Generate a bass line */
  generateBass(bpm: number, bars: number, key: string = "Am"): string {
    const beatDur = 60 / bpm;
    const barDur = beatDur * 4;
    const outPath = `${this.outputDir}/bass-${Date.now()}.wav`;
    const notes = this.scaleFreqs(key, 1); // Octave 1 for bass

    // Create silence base
    const totalDur = barDur * bars;
    execSync(`${SOX} -n -r ${SAMPLE_RATE} -c 1 ${outPath} trim 0 ${totalDur}`);

    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * barDur;
      const rootFreq = notes[0];
      const fifthFreq = notes[4 % notes.length];

      // Simple bass pattern: root on 1, fifth on 3
      const n1 = `${this.outputDir}/_bass_n1.wav`;
      const n2 = `${this.outputDir}/_bass_n2.wav`;
      this.bassNote(n1, rootFreq, beatDur * 1.5);
      this.bassNote(n2, fifthFreq, beatDur * 1.5);
      this.mixAt(outPath, n1, barStart);
      this.mixAt(outPath, n2, barStart + 2 * beatDur);
      try { execSync(`rm ${n1} ${n2}`); } catch {}
    }

    return outPath;
  }

  /** Generate a pad layer */
  generatePad(bpm: number, bars: number, key: string = "Am"): string {
    const barDur = (60 / bpm) * 4;
    const totalDur = barDur * bars;
    const outPath = `${this.outputDir}/pad-${Date.now()}.wav`;
    const notes = this.scaleFreqs(key, 3); // Octave 3 for pads

    // Build a chord: root, minor third, fifth
    const chord = [notes[0], notes[2], notes[4 % notes.length]];
    this.padChord(outPath, chord, totalDur);

    // Add reverb
    const reverbPath = `${outPath}.reverb.wav`;
    execSync(`${SOX} ${outPath} ${reverbPath} reverb 80 50 100 vol 0.6`);
    execSync(`mv ${reverbPath} ${outPath}`);

    return outPath;
  }

  /** Generate a simple melody */
  generateMelody(bpm: number, bars: number, key: string = "Am"): string {
    const beatDur = 60 / bpm;
    const barDur = beatDur * 4;
    const totalDur = barDur * bars;
    const outPath = `${this.outputDir}/melody-${Date.now()}.wav`;
    const notes = this.scaleFreqs(key, 4); // Octave 4 for melody

    execSync(`${SOX} -n -r ${SAMPLE_RATE} -c 1 ${outPath} trim 0 ${totalDur}`);

    // Deterministic but musical melody pattern using bar position
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * barDur;
      // Play notes on beats 1, 2.5, 3.5 with scale degree based on bar number
      const degrees = [0, 2, 4, 5, 7, 4, 2, 0]; // Simple melodic contour
      const degreeOffset = bar % degrees.length;

      for (let i = 0; i < 3; i++) {
        const noteIdx = (degrees[(degreeOffset + i) % degrees.length]) % notes.length;
        const freq = notes[noteIdx];
        const noteDur = beatDur * 0.8;
        const noteStart = barStart + [0, 1.5, 2.5][i] * beatDur;

        const notePath = `${this.outputDir}/_mel_${i}.wav`;
        this.melodyNote(notePath, freq, noteDur);
        this.mixAt(outPath, notePath, noteStart);
        try { execSync(`rm ${notePath}`); } catch {}
      }
    }

    // Add slight delay effect
    const delayPath = `${outPath}.delay.wav`;
    execSync(`${SOX} ${outPath} ${delayPath} echo 0.6 0.6 ${Math.round(beatDur * 375)} 0.3`);
    execSync(`mv ${delayPath} ${outPath}`);

    return outPath;
  }

  /** Mix a sample into a track at a given time offset */
  private mixAt(trackPath: string, samplePath: string, offsetSec: number): void {
    const tmpPath = `${trackPath}.tmp.wav`;
    // Pad sample with silence offset, then mix
    const padded = `${samplePath}.padded.wav`;
    try {
      execSync(`${SOX} ${samplePath} ${padded} pad ${offsetSec.toFixed(4)} 0`);
      execSync(`${SOX} -m ${trackPath} ${padded} ${tmpPath}`);
      execSync(`mv ${tmpPath} ${trackPath}`);
    } catch {}
    try { execSync(`rm ${padded} ${tmpPath} 2>/dev/null`); } catch {}
  }

  /** Get scale frequencies for a given key and octave */
  private scaleFreqs(key: string, octave: number): number[] {
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const isMinor = key.endsWith("m");
    const root = key.replace("m", "");
    const rootIdx = noteNames.indexOf(root);
    if (rootIdx === -1) return this.scaleFreqs("Am", octave); // fallback

    // Minor: W H W W H W W, Major: W W H W W W H
    const intervals = isMinor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];

    return intervals.map((semitone) => {
      const midi = (octave + 1) * 12 + rootIdx + semitone;
      return 440 * Math.pow(2, (midi - 69) / 12);
    });
  }
}
