/**
 * useDJ - React hook bridging the DJ backend to TUI components.
 * Provides state for MusicPlayer widget and handles slash commands.
 */

import { useState, useCallback, useRef, useEffect } from "react";

// Lazy import to avoid circular deps
let djInstance: any = null;

async function getDJ() {
  if (!djInstance) {
    const { DJ } = await import("../../../../packages/music/dj.js");
    djInstance = new DJ();
  }
  return djInstance;
}

export interface DJState {
  isPlaying: boolean;
  isPaused: boolean;
  isLooping: boolean;
  trackTitle: string;
  genre: string;
  bpm: number;
  volume: number;
  position: number;
  duration: number;
  queueLength: number;
}

const INITIAL_STATE: DJState = {
  isPlaying: false,
  isPaused: false,
  isLooping: false,
  trackTitle: "",
  genre: "",
  bpm: 0,
  volume: 80,
  position: 0,
  duration: 0,
  queueLength: 0,
};

export function useDJ() {
  const [state, setState] = useState<DJState>(INITIAL_STATE);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll mpv for position updates when playing
  useEffect(() => {
    if (state.isPlaying && !state.isPaused) {
      pollRef.current = setInterval(() => {
        setState((s) => ({
          ...s,
          position: s.duration > 0 ? (s.position + 1) % s.duration : s.position + 1,
        }));
      }, 1000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [state.isPlaying, state.isPaused]);

  const handleCommand = useCallback(async (sub: string, args: string[]): Promise<string> => {
    const dj = await getDJ();

    switch (sub) {
      case "play": {
        const query = args.join(" ");
        if (!query) return "Usage: /dj play <song or URL>";
        const result = await dj.play(query);
        setState((s) => ({
          ...s,
          isPlaying: true,
          isPaused: false,
          trackTitle: query,
          position: 0,
        }));
        return result;
      }

      case "radio": {
        const genre = args.join(" ") || "lofi";
        const result = await dj.radio(genre);
        setState((s) => ({
          ...s,
          isPlaying: true,
          isPaused: false,
          trackTitle: `Radio: ${genre}`,
          genre,
          duration: 0, // Radio has no duration
          position: 0,
        }));
        return result;
      }

      case "produce":
      case "gen": {
        const genre = args[0] || "house";
        const { MusicProducer } = await import("../../../../packages/music/producer.js");
        const producer = new MusicProducer();
        const track = await producer.produce({ genre: genre as any, durationSec: 60, loop: true });
        producer.loop(track);
        setState((s) => ({
          ...s,
          isPlaying: true,
          isPaused: false,
          trackTitle: `${genre} - ${track.bpm}bpm`,
          genre,
          bpm: track.bpm,
          duration: track.durationSec,
          position: 0,
        }));
        return `Produced and playing: ${genre} at ${track.bpm} BPM`;
      }

      case "pause": {
        const result = await dj.pause();
        setState((s) => ({ ...s, isPaused: !s.isPaused }));
        return result;
      }

      case "stop": {
        dj.stop();
        // Also kill any afplay from producer
        try { require("child_process").execSync("pkill -f afplay 2>/dev/null"); } catch {}
        setState(INITIAL_STATE);
        return "Stopped.";
      }

      case "skip": {
        const result = await dj.skip();
        return result;
      }

      case "np": {
        return await dj.nowPlaying();
      }

      case "vol":
      case "volume": {
        const level = parseInt(args[0] || "80");
        setState((s) => ({ ...s, volume: level }));
        return await dj.volume(level);
      }

      case "repeat":
      case "loop": {
        const result = dj.repeat();
        setState((s) => ({ ...s, isLooping: !s.isLooping }));
        return result;
      }

      case "queue": {
        const query = args.join(" ");
        if (!query) return "Usage: /dj queue <song>";
        const result = dj.queue(query);
        setState((s) => ({ ...s, queueLength: s.queueLength + 1 }));
        return result;
      }

      case "download":
      case "dl": {
        const url = args[0];
        if (!url) return "Usage: /dj dl <url>";
        return dj.download(url);
      }

      case "bpm": {
        const file = args[0];
        if (!file) return "Usage: /dj bpm <file>";
        return dj.bpm(file);
      }

      case "mix": {
        if (args.length < 2) return "Usage: /dj mix <file1> <file2> [crossfade_sec]";
        return dj.mix(args[0], args[1], parseInt(args[2] || "5"));
      }

      case "resume": {
        const result = await dj.resume();
        setState((s) => ({ ...s, isPlaying: true }));
        return result;
      }

      case "presets":
      case "genres": {
        const presets = dj.radioPresets();
        return "Radio presets: " + presets.join(", ");
      }

      case "doctor":
      case "status": {
        const doc = dj.doctor();
        return `DJ Tools:\n  mpv: ${doc.mpv ? "OK" : "MISSING"}\n  yt-dlp: ${doc.ytdlp ? "OK" : "MISSING"}\n  ffmpeg: ${doc.ffmpeg ? "OK" : "MISSING"}\n  sox: ${doc.sox ? "OK" : "MISSING"}\n\nInstall: ${doc.installCmd}`;
      }

      default:
        return [
          "DJ Eight - Commands:",
          "  /dj play <query|url>  - YouTube search + stream",
          "  /dj radio <genre>     - Internet radio (30k+ stations)",
          "  /dj produce <genre>   - Generate a track (sox synth)",
          "  /dj pause             - Toggle pause",
          "  /dj stop              - Stop playback",
          "  /dj skip              - Next in queue",
          "  /dj np                - Now playing",
          "  /dj vol <0-100>       - Volume",
          "  /dj loop              - Toggle repeat",
          "  /dj queue <query>     - Add to queue",
          "  /dj dl <url>          - Download track",
          "  /dj bpm <file>        - Detect BPM",
          "  /dj mix <a> <b>       - Crossfade mix",
          "  /dj resume            - Resume last session",
          "  /dj presets           - List radio genres",
          "  /dj doctor            - Check tool status",
        ].join("\n");
    }
  }, []);

  return { state, handleCommand };
}
