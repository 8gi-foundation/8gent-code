/**
 * duplicate-finder.ts
 * Find duplicate files by SHA-256 hash and similar code blocks.
 * Zero dependencies. CLI-runnable.
 *
 * Usage:
 *   bun packages/validation/duplicate-finder.ts [path] [--json] [--min-block-lines=N]
 */

import { createHash } from "crypto";
import { readdirSync, statSync, readFileSync } from "fs";
import { join, extname } from "path";

export interface DuplicateGroup {
  hash: string;
  size: number;
  wastedBytes: number;
  files: string[];
}

export interface SimilarBlock {
  snippet: string;
  lineCount: number;
  locations: Array<{ file: string; startLine: number }>;
}

export interface DuplicateReport {
  scannedFiles: number;
  duplicateGroups: DuplicateGroup[];
  similarBlocks: SimilarBlock[];
  totalWastedBytes: number;
  totalWastedMB: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".8gent", "dist", "build",
  ".turbo", "coverage", "__pycache__", ".next",
]);

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) walk(full, files);
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function hashFile(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

function findDuplicateFiles(files: string[]): DuplicateGroup[] {
  const hashMap = new Map<string, string[]>();
  for (const file of files) {
    const hash = hashFile(file);
    if (!hash) continue;
    const group = hashMap.get(hash) ?? [];
    group.push(file);
    hashMap.set(hash, group);
  }
  const groups: DuplicateGroup[] = [];
  for (const [hash, paths] of hashMap) {
    if (paths.length < 2) continue;
    let size = 0;
    try { size = statSync(paths[0]).size; } catch { /* ignore */ }
    groups.push({ hash, size, wastedBytes: size * (paths.length - 1), files: paths });
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes);
  return groups;
}

const CODE_EXTENSIONS = new Set([".ts",".tsx",".js",".jsx",".mts",".mjs",".py",".go",".rs"]);

function normalizeLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(
    (l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#")
  );
}

function hashBlock(lines: string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function findSimilarBlocks(files: string[], minLines: number = 6): SimilarBlock[] {
  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(extname(f)));
  const blockMap = new Map<string, Array<{ file: string; startLine: number; snippet: string }>>();
  for (const file of codeFiles) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    const normalized = normalizeLines(content.split("\n"));
    if (normalized.length < minLines) continue;
    for (let i = 0; i <= normalized.length - minLines; i++) {
      const window = normalized.slice(i, i + minLines);
      const bh = hashBlock(window);
      const entry = blockMap.get(bh) ?? [];
      entry.push({ file, startLine: i + 1, snippet: window.slice(0, 3).join("\n") });
      blockMap.set(bh, entry);
    }
  }
  const results: SimilarBlock[] = [];
  for (const [, locations] of blockMap) {
    if (locations.length < 2) continue;
    const seen = new Set<string>();
    const deduped = locations.filter((l) => {
      const key = `${l.file}:${l.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (deduped.length < 2) continue;
    results.push({
      snippet: deduped[0].snippet,
      lineCount: minLines,
      locations: deduped.map(({ file, startLine }) => ({ file, startLine })),
    });
  }
  results.sort((a, b) => b.locations.length - a.locations.length);
  const final: SimilarBlock[] = [];
  const seenSnippets = new Set<string>();
  for (const r of results) {
    const key = r.snippet.slice(0, 80);
    if (seenSnippets.has(key)) continue;
    seenSnippets.add(key);
    final.push(r);
    if (final.length >= 50) break;
  }
  return final;
}

export async function findDuplicates(
  rootDir: string,
  minBlockLines: number = 6
): Promise<DuplicateReport> {
  const files = walk(rootDir);
  const duplicateGroups = findDuplicateFiles(files);
  const similarBlocks = findSimilarBlocks(files, minBlockLines);
  const totalWastedBytes = duplicateGroups.reduce((acc, g) => acc + g.wastedBytes, 0);
  return {
    scannedFiles: files.length,
    duplicateGroups,
    similarBlocks,
    totalWastedBytes,
    totalWastedMB: (totalWastedBytes / 1024 / 1024).toFixed(2),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const minBlockArg = args.find((a) => a.startsWith("--min-block-lines="));
  const minBlockLines = minBlockArg ? parseInt(minBlockArg.split("=")[1], 10) : 6;
  const rootDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  if (!jsonMode) {
    console.log(`\nScanning: ${rootDir}`);
    console.log(`Min block lines: ${minBlockLines}`);
    console.log("---");
  }
  const report = await findDuplicates(rootDir, minBlockLines);
  if (jsonMode) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Files scanned:     ${report.scannedFiles}`);
  console.log(`Duplicate groups:  ${report.duplicateGroups.length}`);
  console.log(`Similar blocks:    ${report.similarBlocks.length}`);
  console.log(`Total wasted:      ${formatBytes(report.totalWastedBytes)} (${report.totalWastedMB} MB)`);
  if (report.duplicateGroups.length > 0) {
    console.log("\n== DUPLICATE FILES ==");
    for (const g of report.duplicateGroups.slice(0, 20)) {
      console.log(`\n  hash: ${g.hash.slice(0, 16)}...  size: ${formatBytes(g.size)}  wasted: ${formatBytes(g.wastedBytes)}`);
      for (const f of g.files) console.log(`    ${f}`);
    }
    if (report.duplicateGroups.length > 20) console.log(`  ... and ${report.duplicateGroups.length - 20} more groups`);
  }
  if (report.similarBlocks.length > 0) {
    console.log("\n== SIMILAR CODE BLOCKS ==");
    for (const b of report.similarBlocks.slice(0, 15)) {
      console.log(`\n  [${b.locations.length} locations, ${b.lineCount} lines]`);
      console.log(`  snippet: ${b.snippet.replace(/\n/g, " | ").slice(0, 100)}`);
      for (const loc of b.locations) console.log(`    ${loc.file}:${loc.startLine}`);
    }
    if (report.similarBlocks.length > 15) console.log(`  ... and ${report.similarBlocks.length - 15} more blocks`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
