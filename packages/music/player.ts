/**
 * Player - Audio playback on macOS using afplay.
 * Supports play, stop, loop, and queue management.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";

export class Player {
  private process: ChildProcess | null = null;
  private looping: boolean = false;
  private currentTrack: string | null = null;
  private queue: string[] = [];

  /** Play a track (stops current playback) */
  play(path: string): void {
    if (!existsSync(path)) {
      console.log(`[player] File not found: ${path}`);
      return;
    }
    this.stop();
    this.currentTrack = path;
    this.startPlayback(path);
    console.log(`[player] Playing: ${path}`);
  }

  /** Play a track on loop until stopped */
  playLoop(path: string): void {
    if (!existsSync(path)) {
      console.log(`[player] File not found: ${path}`);
      return;
    }
    this.stop();
    this.currentTrack = path;
    this.looping = true;
    this.startPlayback(path);
    console.log(`[player] Looping: ${path}`);
  }

  /** Stop playback */
  stop(): void {
    this.looping = false;
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.currentTrack = null;
  }

  /** Add tracks to queue */
  enqueue(...paths: string[]): void {
    this.queue.push(...paths.filter(p => existsSync(p)));
    console.log(`[player] Queue: ${this.queue.length} tracks`);
  }

  /** Play through the queue */
  async playQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const track = this.queue.shift()!;
      this.play(track);
      await this.waitForEnd();
    }
  }

  /** Get current playback status */
  get status(): { playing: boolean; track: string | null; looping: boolean; queueLength: number } {
    return {
      playing: this.process !== null,
      track: this.currentTrack,
      looping: this.looping,
      queueLength: this.queue.length,
    };
  }

  /** Set system volume (0-100) */
  setVolume(percent: number): void {
    const vol = Math.round(Math.max(0, Math.min(100, percent)) * 7 / 100);
    try {
      execSync(`osascript -e "set volume output volume ${percent}"`);
    } catch {}
  }

  private startPlayback(path: string): void {
    this.process = spawn("afplay", [path], { stdio: "ignore" });
    this.process.on("exit", () => {
      this.process = null;
      if (this.looping && this.currentTrack) {
        // Re-start for loop
        this.startPlayback(this.currentTrack);
      }
    });
  }

  private waitForEnd(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) { resolve(); return; }
      this.process.on("exit", () => resolve());
    });
  }
}
