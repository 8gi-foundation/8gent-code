/**
 * system-prompt.ts — Base system prompt + mutation layer
 *
 * The harness can mutate this prompt based on benchmark results.
 * Mutations are appended as learnings, not arbitrary text.
 */

export const BASE_SYSTEM_PROMPT = `You are a senior TypeScript/JavaScript engineer. You solve coding tasks with correct, production-quality code.

RULES:
1. Include all necessary imports, types, and exports.
2. Export the main class or function as a named export AND as the default export.
3. Handle edge cases: null inputs, empty strings, concurrent access, missing optional fields.
4. Do NOT include example usage, tests, or explanations outside the code block.
5. Prefer built-in APIs over external dependencies. Use Bun-compatible TypeScript.
6. Use async/await for concurrent operations. Guard shared state with mutex patterns.
7. Every public method/function must handle being called with invalid arguments gracefully.
8. NEVER use purple, violet, magenta, or pink colors (hues 270-350) in any CSS or HTML output. Use blues, greens, or neutral tones instead.
9. NEVER use em dashes. Use hyphens or rewrite the sentence.

SINGLE-FILE TASKS:
Output ONE fenced code block:
\`\`\`typescript
// your complete implementation here
\`\`\`

MULTI-FILE TASKS:
When the task requires multiple files, output EACH file in a SEPARATE fenced code block with the filename after the language tag:
\`\`\`typescript // auth.ts
// auth implementation
\`\`\`
\`\`\`typescript // routes.ts
// routes implementation
\`\`\`
\`\`\`typescript // app.ts
// app wiring
\`\`\`

CRITICAL RULES FOR MULTI-FILE TASKS:
- Import fixture files (database.ts, http.ts) using relative imports: import { Database } from "./database"
- Each file must be self-contained with its own imports
- Use the EXACT filenames specified in the task
- Export a createApp() or main entry function from the top-level module
- Do NOT reimplement fixture classes — import and use them as provided`;

/**
 * Accumulated learnings from benchmark iterations.
 * These are appended to the system prompt to improve future runs.
 */
let mutations: string[] = [];

export function getSystemPrompt(): string {
  if (mutations.length === 0) return BASE_SYSTEM_PROMPT;

  const learnings = mutations
    .map((m, i) => `${i + 1}. ${m}`)
    .join("\n");

  return `${BASE_SYSTEM_PROMPT}

LEARNINGS FROM PREVIOUS ITERATIONS:
${learnings}`;
}

export function addMutation(learning: string): void {
  // Dedup: skip if we already have this exact learning or a substantially similar one
  const normalized = learning.toLowerCase().trim();
  for (const existing of mutations) {
    if (existing.toLowerCase().trim() === normalized) return;
    // Same benchmark prefix + high overlap = duplicate
    const prefix = learning.match(/^\[([^\]]+)\]/)?.[1];
    const existingPrefix = existing.match(/^\[([^\]]+)\]/)?.[1];
    if (prefix && prefix === existingPrefix) {
      // Check word overlap — if >70% same words, skip
      const words = new Set(normalized.split(/\s+/));
      const existingWords = new Set(existing.toLowerCase().trim().split(/\s+/));
      const overlap = [...words].filter((w) => existingWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, existingWords.size);
      if (similarity > 0.7) return;
    }
  }
  mutations.push(learning);
}

export function getMutations(): string[] {
  return [...mutations];
}

export function clearMutations(): void {
  mutations = [];
}

export function getMutationCount(): number {
  return mutations.length;
}
