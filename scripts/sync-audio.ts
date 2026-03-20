#!/usr/bin/env bun
/**
 * Audio Accessibility Sync
 *
 * Watches key .md files and auto-generates TTS audio versions.
 * Run once to generate all, or with --watch to auto-update on changes.
 *
 * Usage:
 *   bun run scripts/sync-audio.ts          # generate all
 *   bun run scripts/sync-audio.ts --watch  # watch for changes
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, watch } from "fs";
import { join, basename } from "path";

const ROOT = join(import.meta.dir, "..");
const AUDIO_DIR = join(ROOT, "docs", "audio");
const CHECKSUMS_FILE = join(AUDIO_DIR, ".checksums.json");

// Key files that get audio versions
const TRACKED_FILES = [
  "SOUL.md",
  "CLAUDE.md",
  "README.md",
  "docs/BRANCH-DECISIONS.md",
  "docs/REBUILD-PLAN.md",
  "CHANGELOG.md",
];

mkdirSync(AUDIO_DIR, { recursive: true });

function cleanForTTS(markdown: string): string {
  return markdown
    .replace(/^#+\s*/gm, "")          // remove heading markers
    .replace(/\*\*/g, "")             // remove bold
    .replace(/\*/g, "")               // remove italic
    .replace(/`[^`]*`/g, (m) => m.replace(/`/g, "")) // remove inline code markers
    .replace(/```[\s\S]*?```/g, "")   // remove code blocks entirely
    .replace(/\|/g, " ")             // remove table pipes
    .replace(/^---$/gm, "")          // remove horizontal rules
    .replace(/^>\s*/gm, "")          // remove blockquotes
    .replace(/^\s*[-*]\s+/gm, ". ")  // bullets to periods
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links to text
    .replace(/!\[.*?\]\(.*?\)/g, "") // remove images
    .replace(/\n{3,}/g, "\n\n")      // collapse newlines
    .trim();
}

function getChecksum(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

function loadChecksums(): Record<string, string> {
  if (existsSync(CHECKSUMS_FILE)) {
    try { return JSON.parse(readFileSync(CHECKSUMS_FILE, "utf-8")); } catch {}
  }
  return {};
}

function saveChecksums(checksums: Record<string, string>): void {
  writeFileSync(CHECKSUMS_FILE, JSON.stringify(checksums, null, 2));
}

function generateAudio(mdPath: string, force = false): boolean {
  const fullPath = join(ROOT, mdPath);
  if (!existsSync(fullPath)) {
    console.log(`  ⏭ ${mdPath} — file not found, skipping`);
    return false;
  }

  const content = readFileSync(fullPath, "utf-8");
  const checksum = getChecksum(content);
  const checksums = loadChecksums();
  const audioFile = join(AUDIO_DIR, basename(mdPath, ".md") + ".aiff");

  // Skip if unchanged
  if (!force && checksums[mdPath] === checksum && existsSync(audioFile)) {
    console.log(`  ✓ ${mdPath} — unchanged`);
    return false;
  }

  // Clean and generate
  const cleaned = cleanForTTS(content);
  const tmpFile = join(AUDIO_DIR, ".tmp-tts.txt");
  writeFileSync(tmpFile, cleaned);

  try {
    console.log(`  🔊 ${mdPath} → ${basename(audioFile)}...`);
    execSync(`say -v Ava -o "${audioFile}" -f "${tmpFile}"`, { timeout: 120000 });
    const size = (statSync(audioFile).size / 1024 / 1024).toFixed(1);
    console.log(`  ✅ ${basename(audioFile)} (${size}MB)`);

    // Update checksum
    checksums[mdPath] = checksum;
    saveChecksums(checksums);
    return true;
  } catch (err: any) {
    console.error(`  ❌ ${mdPath} — TTS failed: ${err.message}`);
    return false;
  }
}

// Main
const isWatch = process.argv.includes("--watch");
const isForce = process.argv.includes("--force");

console.log("🔊 Audio Accessibility Sync");
console.log(`   Files: ${TRACKED_FILES.length}`);
console.log(`   Output: docs/audio/\n`);

let generated = 0;
for (const file of TRACKED_FILES) {
  if (generateAudio(file, isForce)) generated++;
}
console.log(`\n${generated} file(s) updated.`);

if (isWatch) {
  console.log("\n👁 Watching for changes... (Ctrl+C to stop)\n");
  for (const file of TRACKED_FILES) {
    const fullPath = join(ROOT, file);
    if (!existsSync(fullPath)) continue;
    watch(fullPath, () => {
      console.log(`\n📝 ${file} changed`);
      generateAudio(file);
    });
  }
  // Keep alive
  setInterval(() => {}, 60000);
}
