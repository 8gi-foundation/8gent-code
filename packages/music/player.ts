/**
 * Player - Audio playback on macOS using afplay.
 * Supports play, stop, loop, and queue management.
 *
 * Every afplay a Player starts is its own child, stopped by its own handle.
 * Nothing here stops a process by name (#3183): a name pattern also hits the
 * afplay of other apps, other sessions, TTS and voice notes.
 */

import { type ChildProcess, type SpawnOptions, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnImpl: Spawn = spawn;

/** Tests swap the spawner for a stub; call with nothing to restore node's spawn. */
export function setPlayerSpawn(fn?: Spawn): void {
	spawnImpl = fn ?? spawn;
}

/** Players with a child running right now. */
const live = new Set<Player>();

/**
 * Stop every Player this process started, and only those, each by its own
 * child handle. Returns how many were playing. /dj stop uses it for the
 * producer's afplay.
 */
export function stopOwnPlayers(): number {
	const n = live.size;
	for (const p of [...live]) p.stop();
	return n;
}

export class Player {
	private process: ChildProcess | null = null;
	private looping = false;
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
			try {
				this.process.kill();
			} catch {}
			this.process = null;
		}
		live.delete(this);
		this.currentTrack = null;
	}

	/** Add tracks to queue */
	enqueue(...paths: string[]): void {
		this.queue.push(...paths.filter((p) => existsSync(p)));
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
	get status(): {
		playing: boolean;
		track: string | null;
		looping: boolean;
		queueLength: number;
	} {
		return {
			playing: this.process !== null,
			track: this.currentTrack,
			looping: this.looping,
			queueLength: this.queue.length,
		};
	}

	/** Set system volume (0-100) */
	setVolume(percent: number): void {
		const vol = Math.round((Math.max(0, Math.min(100, percent)) * 7) / 100);
		try {
			execSync(`osascript -e "set volume output volume ${percent}"`);
		} catch {}
	}

	private startPlayback(path: string): void {
		const child = spawnImpl("afplay", [path], { stdio: "ignore" });
		this.process = child;
		live.add(this);
		child.on("exit", () => {
			// A child already replaced (stop, then play again) must not clear its successor.
			if (this.process !== child) return;
			this.process = null;
			if (this.looping && this.currentTrack) {
				// Re-start for loop
				this.startPlayback(this.currentTrack);
			} else {
				live.delete(this);
			}
		});
	}

	private waitForEnd(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.process) {
				resolve();
				return;
			}
			this.process.on("exit", () => resolve());
		});
	}
}
