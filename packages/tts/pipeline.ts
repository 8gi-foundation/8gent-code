/**
 * KittenTTS audio pipeline for Telegram.
 * Fetches a GitHub issue, chunks by section, generates voice per officer, sends.
 */

import { spawn } from "bun";
import { unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const KITTEN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "kitten.py");
const TEMP_DIR = "/tmp/8gent-tts";

// Officer → KittenTTS voice
const OFFICER_VOICES: Record<string, string> = {
  "8EO": "Jasper",
  "8TO": "Bruno",
  "8CO": "Hugo",
  "8GO": "Leo",
  "8PO": "Bella",
  "8DO": "Luna",
  "8SO": "Rosie",
  "8MO": "Kiki",
};

const OFFICER_LIST = Object.keys(OFFICER_VOICES);

export interface AudioChunk {
  text: string;
  voice: string;
  officer: string;
  wavPath: string;
}

export async function generateAudio(text: string, voice: string, outPath: string): Promise<void> {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

  const uv = process.env.UV_BIN ?? "/Users/jamesspalding/.local/bin/uv";
  const proc = spawn([uv, "run", "--with", "kittentts", "python3", KITTEN_SCRIPT, text, voice, outPath], {
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: "/opt/homebrew/lib",
    },
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`KittenTTS failed (${exitCode}): ${err}`);
  }
}

export function chunkIssueContent(title: string, body: string): { text: string; officer: string }[] {
  const chunks: { text: string; officer: string }[] = [];
  let officerIndex = 0;

  const nextOfficer = () => OFFICER_LIST[officerIndex++ % OFFICER_LIST.length];

  // Title as first chunk
  chunks.push({ text: title + ".", officer: nextOfficer() });

  // Split on ## headings
  const sections = body.split(/\n(?=##\s)/);
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const heading = lines[0]?.replace(/^#+\s*/, "").trim();
    const filteredLines = lines
      .slice(1)
      .filter((l) => !/^\s*[-|:]+[-|\s:]*$/.test(l))  // strip table separator rows
      .filter((l) => !/^\s*(\S+\s+){2,}\S+\s*$/.test(l) || l.trim().split(/\s+/).some((w) => /[a-z]{3,}/i.test(w) && /[aeiou]/i.test(w)));

    const content = filteredLines
      .join(" ")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[|─┼┤├┬┴]/g, " ")
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
      .replace(/#+\s*/g, "")           // strip inline ### headings
      .replace(/[-\w]+-\w+-\d+-[mf]\b/g, "") // strip expr-voice-X-Y tokens
      .replace(/\s+/g, " ")
      .trim();

    if (!content && !heading) continue;

    const chunkText = heading ? `${heading}. ${content}` : content;

    // Max ~50 words per chunk - ONNX model has a hard sequence-length cap
    const words = chunkText.split(" ");
    for (let i = 0; i < words.length; i += 50) {
      const slice = words.slice(i, i + 50).join(" ").trim();
      if (slice.length > 20) {
        chunks.push({ text: slice, officer: nextOfficer() });
      }
    }
  }

  return chunks;
}

export async function fetchGithubIssue(repo: string, issueNumber: number): Promise<{ title: string; body: string }> {
  try {
    const ghBin = "/opt/homebrew/bin/gh";
    const out = execSync(`${ghBin} issue view ${issueNumber} --repo ${repo} --json title,body`, {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` },
    });
    const data = JSON.parse(out) as { title: string; body: string };
    return data;
  } catch (err: any) {
    throw new Error(`Failed to fetch issue ${issueNumber} from ${repo}: ${err.message}`);
  }
}

export async function buildAudioChunks(
  title: string,
  body: string
): Promise<AudioChunk[]> {
  const chunks = chunkIssueContent(title, body);
  const result: AudioChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { text, officer } = chunks[i];
    const voice = OFFICER_VOICES[officer] ?? "Jasper";
    const wavPath = join(TEMP_DIR, `chunk-${Date.now()}-${i}.wav`);

    try {
      await generateAudio(text, voice, wavPath);
      result.push({ text, voice, officer, wavPath });
    } catch {
      // skip chunks that exceed model sequence length rather than aborting all
    }
  }

  return result;
}

export function cleanupChunks(chunks: AudioChunk[]): void {
  for (const chunk of chunks) {
    try { unlinkSync(chunk.wavPath); } catch {}
  }
}
