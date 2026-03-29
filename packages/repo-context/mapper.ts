/**
 * Repo Context Mapper - Phase 1 (regex-based)
 * Scans source files, builds import graph, ranks by relevance to query.
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";

const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs"]);
const SKIP = /node_modules|\.git|dist|build|\.8gent|\.next/;
const CHARS_PER_TOKEN = 4;

export interface FileEntry {
  path: string; imports: string[]; exports: string[];
  size: number; mtime: number;
}
export interface RankedFile {
  path: string; score: number; content: string; mode: "full" | "outline";
}

export class RepoMapper {
  private files = new Map<string, FileEntry>();
  private root = "";

  async scan(rootDir: string): Promise<number> {
    this.root = rootDir; this.files.clear();
    await this.walk(rootDir);
    return this.files.size;
  }

  private async walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (SKIP.test(e.name)) continue;
      if (e.isDirectory()) { await this.walk(full); continue; }
      if (!EXTS.has(extname(e.name))) continue;
      try {
        const [info, raw] = await Promise.all([stat(full), readFile(full, "utf-8")]);
        const rel = relative(this.root, full);
        this.files.set(rel, {
          path: rel, imports: this.extractImports(raw),
          exports: this.extractExports(raw), size: info.size, mtime: info.mtimeMs,
        });
      } catch { /* skip */ }
    }
  }

  private extractImports(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1]);
    for (const m of src.matchAll(/require\(["']([^"']+)["']\)/g)) out.push(m[1]);
    for (const m of src.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) out.push(m[1]);
    for (const m of src.matchAll(/^\s*use\s+([\w:]+)/gm)) out.push(m[1]);
    return out;
  }

  private extractExports(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g))
      out.push(m[1]);
    return out;
  }

  rank(query: string): RankedFile[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const vals = [...this.files.values()];
    const maxMtime = Math.max(...vals.map(f => f.mtime), 1);
    const maxImp = Math.max(...vals.map(f => this.importers(f.path)), 1);
    const scored: { path: string; score: number }[] = [];

    for (const [rel, entry] of this.files) {
      const hay = (rel + " " + entry.exports.join(" ")).toLowerCase();
      const text = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) / Math.max(terms.length, 1);
      const recency = entry.mtime / maxMtime;
      const central = this.importers(rel) / maxImp;
      const small = 1 - Math.min(entry.size / 50_000, 1);
      const score = 0.4 * text + 0.25 * recency + 0.2 * central + 0.15 * small;
      if (score > 0.05) scored.push({ path: rel, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 20)
      .map(({ path, score }) => ({ path, score, content: "", mode: "full" as const }));
  }

  private importers(rel: string): number {
    const name = basename(rel, extname(rel));
    let n = 0;
    for (const e of this.files.values()) if (e.imports.some(i => i.includes(name))) n++;
    return n;
  }

  async getContext(query: string, maxTokens = 4000): Promise<string> {
    if (this.files.size === 0) return "";
    const ranked = this.rank(query);
    const parts: string[] = [];
    let tokens = 0;

    for (const file of ranked) {
      const entry = this.files.get(file.path);
      if (!entry) continue;
      let content: string;
      try { content = await readFile(join(this.root, file.path), "utf-8"); } catch { continue; }
      const est = Math.ceil(content.length / CHARS_PER_TOKEN);

      if (tokens + est > maxTokens && tokens > 0) {
        const outline = `// Exports: ${entry.exports.join(", ") || "default"}`;
        const outTok = Math.ceil(outline.length / CHARS_PER_TOKEN);
        if (tokens + outTok > maxTokens) break;
        parts.push(`### ${file.path} (score: ${file.score.toFixed(2)}, outline)\n${outline}`);
        tokens += outTok;
      } else {
        parts.push(`### ${file.path} (score: ${file.score.toFixed(2)})\n\`\`\`\n${content}\n\`\`\``);
        tokens += est;
      }
    }
    if (parts.length === 0) return "";
    return `## Repo Context (auto-selected, ${parts.length} files, ~${tokens} tokens)\n\n${parts.join("\n\n")}`;
  }
}
