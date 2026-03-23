/**
 * Auto-Inject — assemble memory context for system prompt injection before each agent turn.
 *
 * Builds a [Memory Context]...[/Memory Context] block containing:
 *   1. User/agent representation (if available)
 *   2. Relevant memories based on recent conversation
 *
 * Deduplicates memories against the representation to avoid repetition.
 */

import type { MemoryStore } from "./store.js";
import type { PeerRepresentation } from "./types.js";
import { estimateTokens } from "./types.js";

export interface AutoInjectConfig {
  maxTokens?: number;
  maxResults?: number;
}

/**
 * Build memory context string for injection into the system prompt.
 * Accepts a token budget and returns formatted context within that budget.
 */
export async function buildMemoryContext(
  userId: string,
  recentMessages: string[],
  store: MemoryStore,
  representation: PeerRepresentation | null,
  config: AutoInjectConfig = {}
): Promise<string> {
  const maxTokens = config.maxTokens ?? 2000;
  const maxResults = config.maxResults ?? 8;

  let usedTokens = 0;
  let context = "[Memory Context]\n";

  // 1. Inject representation if available
  if (representation?.summary) {
    const repTokens = estimateTokens(representation.summary);
    if (repTokens < maxTokens * 0.4) {
      context += `Profile: ${representation.summary}\n\n`;
      usedTokens += repTokens;
    }
  }

  // 2. Search for relevant memories based on recent conversation
  const query = recentMessages.slice(-3).join(" ");
  if (!query.trim()) {
    context += "[/Memory Context]";
    return context;
  }

  const remainingBudget = maxTokens - usedTokens;
  const results = await store.recall(query, { limit: maxResults * 2 });

  // 3. Deduplicate against representation — skip memories whose content
  //    is substantially covered by the profile text
  const profileText = representation?.summary?.toLowerCase() ?? "";
  const dedupedResults = results.filter((r) => {
    const memContent = extractContent(r.memory).toLowerCase();
    const words = memContent.split(/\s+/).filter((w) => w.length > 3);
    const overlapCount = words.filter((w) => profileText.includes(w)).length;
    const overlapRatio = words.length > 0 ? overlapCount / words.length : 0;
    return overlapRatio < 0.6; // Keep if less than 60% overlap with profile
  });

  // 4. Format within token budget
  const memoryLines: string[] = [];
  let memTokens = 0;
  for (const r of dedupedResults.slice(0, maxResults)) {
    const line = `- ${extractContent(r.memory)}`;
    const lineTokens = estimateTokens(line);
    if (memTokens + lineTokens > remainingBudget) break;
    memoryLines.push(line);
    memTokens += lineTokens;
  }

  if (memoryLines.length > 0) {
    context += "Relevant memories:\n";
    context += memoryLines.join("\n");
    context += "\n";
  }

  context += "[/Memory Context]";
  return context;
}

function extractContent(memory: Record<string, unknown>): string {
  const m = memory as Record<string, string>;
  return m.content || m.value || m.title || m.description || m.name || "";
}
