/**
 * Semantic Search over Codebase Files
 *
 * Uses Ollama embeddings (nomic-embed-text) to index file contents and find
 * semantically similar files to a natural language query. No external deps
 * beyond Ollama running locally.
 */

export interface FileEmbedding {
  path: string;
  embedding: number[];
  chunkPreview: string;
}

export interface SearchResult {
  path: string;
  score: number;
  preview: string;
}

export interface SemanticIndex {
  model: string;
  files: FileEmbedding[];
  createdAt: string;
}

const DEFAULT_MODEL = 'nomic-embed-text';
const OLLAMA_URL = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const MAX_CHUNK_CHARS = 2048;

/** Fetch an embedding vector from Ollama. */
async function embed(text: string, model = DEFAULT_MODEL): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

/** Cosine similarity between two vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Recursively collect files from a directory, respecting common ignores. */
async function collectFiles(dir: string, exts: string[]): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');

  const IGNORE = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
    '.8gent', '.claude', 'coverage', '__pycache__',
  ]);

  const results: string[] = [];

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (exts.length === 0 || exts.includes(extname(entry.name))) {
        const info = await stat(full);
        // Skip files larger than 100KB - likely generated or binary
        if (info.size < 100_000) results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Build a semantic index of all matching files in a directory.
 * Embeds the first MAX_CHUNK_CHARS of each file via Ollama.
 */
export async function buildIndex(
  rootDir: string,
  opts: { extensions?: string[]; model?: string } = {},
): Promise<SemanticIndex> {
  const { readFile } = await import('node:fs/promises');
  const { relative } = await import('node:path');

  const exts = opts.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.md', '.json'];
  const model = opts.model ?? DEFAULT_MODEL;
  const paths = await collectFiles(rootDir, exts);
  const files: FileEmbedding[] = [];

  for (const filePath of paths) {
    const raw = await readFile(filePath, 'utf-8');
    const chunk = raw.slice(0, MAX_CHUNK_CHARS);
    if (chunk.trim().length === 0) continue;

    const relPath = relative(rootDir, filePath);
    try {
      const embedding = await embed(`file: ${relPath}\n${chunk}`, model);
      files.push({ path: relPath, embedding, chunkPreview: chunk.slice(0, 120) });
    } catch {
      // Skip files that fail to embed (Ollama might be down, etc.)
      continue;
    }
  }

  return { model, files, createdAt: new Date().toISOString() };
}

/**
 * Search the index for files semantically similar to a query.
 * Returns top-k results sorted by cosine similarity (descending).
 */
export async function search(
  query: string,
  index: SemanticIndex,
  opts: { topK?: number; model?: string } = {},
): Promise<SearchResult[]> {
  const topK = opts.topK ?? 10;
  const model = opts.model ?? index.model;
  const queryVec = await embed(query, model);

  const scored = index.files.map((f) => ({
    path: f.path,
    score: cosine(queryVec, f.embedding),
    preview: f.chunkPreview,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Pretty-print search results to stdout. */
export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `${i + 1}. [${r.score.toFixed(3)}] ${r.path}\n   ${r.preview}`)
    .join('\n\n');
}
