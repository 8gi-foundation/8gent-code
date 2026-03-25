/**
 * Snippet Manager - save, list, search, and retrieve reusable code snippets.
 * Storage: ~/.8gent/snippets/ as individual JSON files.
 * Supports tags, full-text search, and clipboard copy (macOS pbcopy).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const SNIPPETS_DIR = join(
  process.env.HOME ?? "~",
  ".8gent",
  "snippets"
);

export interface Snippet {
  id: string;
  title: string;
  code: string;
  language: string;
  tags: string[];
  createdAt: string;
}

function ensureDir(): void {
  if (!existsSync(SNIPPETS_DIR)) {
    mkdirSync(SNIPPETS_DIR, { recursive: true });
  }
}

function snippetPath(id: string): string {
  return join(SNIPPETS_DIR, `${id}.json`);
}

/** Save a new snippet. Returns the created snippet. */
export function saveSnippet(opts: {
  title: string;
  code: string;
  language?: string;
  tags?: string[];
}): Snippet {
  ensureDir();
  const snippet: Snippet = {
    id: randomUUID().slice(0, 8),
    title: opts.title,
    code: opts.code,
    language: opts.language ?? "text",
    tags: opts.tags ?? [],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(snippetPath(snippet.id), JSON.stringify(snippet, null, 2));
  return snippet;
}

/** List all saved snippets (metadata only, code truncated). */
export function listSnippets(): Omit<Snippet, "code">[] {
  ensureDir();
  const files = readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(SNIPPETS_DIR, f), "utf-8")) as Snippet;
    const { code: _code, ...meta } = raw;
    return meta;
  });
}

/** Get a snippet by ID. Returns null if not found. */
export function getSnippet(id: string): Snippet | null {
  const p = snippetPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Snippet;
}

/** Delete a snippet by ID. Returns true if deleted. */
export function deleteSnippet(id: string): boolean {
  const p = snippetPath(id);
  if (!existsSync(p)) return false;
  const { unlinkSync } = require("fs");
  unlinkSync(p);
  return true;
}

/** Search snippets by query string (matches title, tags, code, language). */
export function searchSnippets(query: string): Snippet[] {
  ensureDir();
  const q = query.toLowerCase();
  const files = readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith(".json"));
  const results: Snippet[] = [];
  for (const f of files) {
    const snippet = JSON.parse(readFileSync(join(SNIPPETS_DIR, f), "utf-8")) as Snippet;
    const haystack = [
      snippet.title,
      snippet.language,
      snippet.code,
      ...snippet.tags,
    ]
      .join(" ")
      .toLowerCase();
    if (haystack.includes(q)) {
      results.push(snippet);
    }
  }
  return results;
}

/** Filter snippets that have ALL of the given tags. */
export function filterByTags(tags: string[]): Snippet[] {
  ensureDir();
  const lower = tags.map((t) => t.toLowerCase());
  const files = readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => JSON.parse(readFileSync(join(SNIPPETS_DIR, f), "utf-8")) as Snippet)
    .filter((s) => lower.every((t) => s.tags.map((x) => x.toLowerCase()).includes(t)));
}

/** Copy snippet code to clipboard (macOS). Returns true on success. */
export function copyToClipboard(id: string): boolean {
  const snippet = getSnippet(id);
  if (!snippet) return false;
  try {
    execSync("pbcopy", { input: snippet.code });
    return true;
  } catch {
    return false;
  }
}
