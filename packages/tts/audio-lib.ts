/**
 * Instant audio nudge library.
 * Pre-generated KittenTTS clips fired immediately while processing continues.
 * Select by message bucket → random pick → tgSendVoice.
 */

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

export type AudioBucket = "greeting" | "ack" | "thinking" | "working";

export const PHRASES: Record<AudioBucket, string[]> = {
  greeting: [
    "Yo, what's up James",
    "Ah, there you are",
    "Hey!",
    "There he is",
    "What's good mate",
    "Good to hear from you",
    "Hey hey hey",
    "Ah James, what's the craic",
    "Yo",
    "Nice to hear from ya",
    "Ah, you're back",
    "Hey, how's it going",
  ],
  ack: [
    "Yeah nice",
    "Love that",
    "Solid",
    "Good shout",
    "Fair play",
    "Oh interesting",
    "Yeah fair enough",
    "Makes sense to me",
    "Absolutely",
    "Ha, yeah",
    "That's class",
    "Nice one",
    "Right on",
  ],
  thinking: [
    "Give me a sec",
    "Let me think about that",
    "Hmm",
    "Interesting question",
    "Good one",
    "Ok, let me think",
    "One moment",
    "Right, working that out",
    "Hmm, good point",
    "Interesting",
    "Ok ok, thinking",
    "Yeah let me mull that over",
  ],
  working: [
    "On it",
    "On it now",
    "Working on it",
    "Let me check that",
    "Checking now",
    "Right, looking into it",
    "Give me a moment",
    "Already on it",
    "Let me pull that up",
    "One sec",
    "Right, got it, on it",
    "Yeah, on that now",
  ],
};

const LIB_DIR = join(homedir(), ".8gent", "audio-lib");

export function libPath(bucket: AudioBucket, index: number): string {
  return join(LIB_DIR, bucket, `${index}.wav`);
}

/** Pick a random existing clip from the bucket. Returns null if none exist. */
export function pickClip(bucket: AudioBucket): string | null {
  const dir = join(LIB_DIR, bucket);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".wav"));
  if (!files.length) return null;
  const pick = files[Math.floor(Math.random() * files.length)];
  return join(dir, pick);
}

/**
 * Classify a message into an audio bucket.
 * Simple rules - order matters (first match wins).
 */
export function classifyBucket(text: string): AudioBucket {
  const t = text.trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);

  // Greeting signals
  if (/^(hey|hi|hello|yo|sup|howdy|morning|evening|what'?s up|what'?s good|how are you|you there|you around)\b/.test(t)) {
    return "greeting";
  }

  // Task / working signals - something needs to be done
  const workingVerbs = /\b(fix|create|build|add|update|generate|write|make|install|configure|debug|refactor|implement|deploy|setup|launch|ship|check|find|search|fetch|run|retrieve|list|show|get)\b/;
  if (workingVerbs.test(t) || t.startsWith("/")) {
    return "working";
  }

  // Thinking signals - questions or reflective statements
  if (words.length > 3 && /\b(what|how|why|when|where|who|which|do you|can you|could you|would you|think|feel|reckon)\b/.test(t)) {
    return "thinking";
  }

  // Short reactions default to ack
  return "ack";
}
