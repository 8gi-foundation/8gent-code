/**
 * Query Expansion for Memory FTS5 Search
 *
 * Expands query terms with synonyms for common coding terms
 * to improve recall without requiring exact keyword matches.
 */
const SYNONYMS: Record<string, string[]> = {
  function: ["method", "func"], method: ["function", "func"],
  error: ["exception", "failure", "bug"], exception: ["error", "throw"],
  bug: ["error", "issue", "defect"], test: ["spec", "assert"],
  config: ["configuration", "settings"], deploy: ["release", "ship"],
  build: ["compile", "bundle"], api: ["endpoint", "route"],
  database: ["db", "store"], db: ["database", "store"],
  auth: ["authentication", "login"], install: ["setup", "init"],
  fix: ["patch", "resolve"], refactor: ["restructure", "rewrite"],
  import: ["require", "load"], component: ["widget", "module"],
  type: ["interface", "schema"],
};

/** Expand a query with synonyms for better FTS5 recall. */
export function expandQuery(query: string): string {
  const terms = query.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return query;
  const expanded = new Set<string>(terms);
  for (const t of terms) { const syns = SYNONYMS[t]; if (syns) for (const s of syns) expanded.add(s); }
  return Array.from(expanded).map((t) => `${t}*`).join(" OR ");
}
