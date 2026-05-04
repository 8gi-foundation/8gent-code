/**
 * One-time script: pre-generate all audio-lib clips using KittenTTS.
 * Run with: bun run packages/tts/generate-lib.ts
 * Output: ~/.8gent/audio-lib/{bucket}/{n}.wav
 */

import { PHRASES, AudioBucket, libPath } from "./audio-lib";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "bun";

const KITTEN_SCRIPT = join(import.meta.dir, "kitten.py");
const UV = "/home/operator/.local/bin/uv";

const BUCKET_VOICES: Record<AudioBucket, string> = {
  greeting: "Jasper",
  ack: "Jasper",
  thinking: "Jasper",
  working: "Jasper",
};

async function generate(text: string, voice: string, outPath: string): Promise<boolean> {
  mkdirSync(dirname(outPath), { recursive: true });
  const proc = spawn([UV, "run", "--with", "kittentts", "python3", KITTEN_SCRIPT, text, voice, outPath], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, DYLD_LIBRARY_PATH: "/opt/homebrew/lib" },
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    console.error(`  FAIL [${code}]: ${err.split("\n").pop()}`);
    return false;
  }
  return true;
}

async function main() {
  const buckets = Object.keys(PHRASES) as AudioBucket[];
  let total = 0;
  let ok = 0;

  for (const bucket of buckets) {
    const phrases = PHRASES[bucket];
    const voice = BUCKET_VOICES[bucket];
    console.log(`\n[${bucket}] ${phrases.length} phrases → voice: ${voice}`);

    for (let i = 0; i < phrases.length; i++) {
      const phrase = phrases[i];
      const out = libPath(bucket, i);
      if (existsSync(out)) {
        console.log(`  [${i}] skip (exists): "${phrase}"`);
        ok++;
        total++;
        continue;
      }
      process.stdout.write(`  [${i}] "${phrase}" ... `);
      const success = await generate(phrase, voice, out);
      if (success) {
        console.log("ok");
        ok++;
      }
      total++;
    }
  }

  console.log(`\nDone. ${ok}/${total} clips generated at ~/.8gent/audio-lib/`);
}

main().catch(console.error);
