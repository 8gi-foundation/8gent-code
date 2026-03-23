/**
 * Peer Representations - natural language descriptions of users/agents
 * based on accumulated memories.
 *
 * These short paragraphs get injected into system prompts for personalization.
 */

import { generateText } from "ai";
import { createModel } from "../ai/providers.js";
import type { Database } from "bun:sqlite";

export interface PeerRepresentation {
  userId: string;
  representation: string;
  updatedAt: string;
  memoryCount: number;
  topCategories: string[];
}

interface RepresentationConfig {
  model?: string;
  runtime?: string;
  apiKey?: string;
}

/**
 * Generate a natural language representation of a user/agent
 * based on their accumulated memories.
 *
 * This paragraph gets injected into the system prompt for personalization.
 */
export async function generateRepresentation(
  userId: string,
  db: Database,
  config?: RepresentationConfig
): Promise<PeerRepresentation> {
  // Query all memories for this userId, ordered by importance then recency
  const rows = db
    .prepare(
      `SELECT data, importance, type, created_at
       FROM memories
       WHERE deleted_at IS NULL
         AND json_extract(data, '$.userId') = ?
       ORDER BY importance DESC, created_at DESC
       LIMIT 100`
    )
    .all(userId) as Array<{
    data: string;
    importance: number;
    type: string;
    created_at: number;
  }>;

  // Count categories from the parsed data
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const parsed = JSON.parse(row.data);
    const cat = parsed.category || parsed.type || "unknown";
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }

  // Top 5 categories by count
  const topCategories = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => cat);

  // Use top 50 for the LLM prompt
  const top50 = rows.slice(0, 50);
  const bullets = top50
    .map((row) => {
      const parsed = JSON.parse(row.data);
      const content =
        parsed.content || parsed.value || parsed.title || parsed.description || parsed.name || "";
      return `- (${row.type}) ${content}`;
    })
    .join("\n");

  const modelId = config?.model || process.env.DEFAULT_MODEL || "auto:free";
  const runtime = config?.runtime || "openrouter";

  let representation: string;

  try {
    const model = createModel({
      name: runtime as "ollama" | "lmstudio" | "openrouter",
      model: modelId,
      apiKey: config?.apiKey,
    });

    const { text } = await generateText({
      model,
      prompt: `Based on these accumulated observations, write a 2-3 sentence description of this person/agent. Be specific about their preferences, patterns, and priorities. Do not speculate beyond what the data shows.

OBSERVATIONS:
${bullets}

DESCRIPTION:`,
    });

    representation = text.trim();
  } catch {
    // Deterministic fallback if LLM is unavailable
    representation = `User with ${rows.length} memories across categories: ${topCategories.join(", ")}`;
  }

  return {
    userId,
    representation,
    updatedAt: new Date().toISOString(),
    memoryCount: rows.length,
    topCategories,
  };
}
