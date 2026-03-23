/**
 * LLM-powered natural language memory queries.
 *
 * Instead of keyword search, this uses an LLM to reason over
 * accumulated memories and answer questions about a user/agent.
 */

import { generateText } from "ai";
import { createModel } from "../ai/providers.js";
import type { Database } from "bun:sqlite";

interface AskConfig {
  model?: string;
  runtime?: string;
  apiKey?: string;
}

/**
 * Ask a natural language question about a user's memories.
 * Uses the LLM to reason over accumulated memories rather than keyword search.
 *
 * Examples:
 *   askMemory("What does James care about most?", "james", db)
 *   askMemory("What mistakes has this agent made before?", agentId, db)
 *   askMemory("What learning style does this user prefer?", userId, db)
 */
export async function askMemory(
  question: string,
  userId: string,
  db: Database,
  config?: AskConfig
): Promise<string> {
  // Query memories for this userId from the JSON data column
  const rows = db
    .prepare(
      `SELECT data, importance, type, created_at
       FROM memories
       WHERE deleted_at IS NULL
         AND json_extract(data, '$.userId') = ?
       ORDER BY importance DESC
       LIMIT 50`
    )
    .all(userId) as Array<{
    data: string;
    importance: number;
    type: string;
    created_at: number;
  }>;

  if (rows.length === 0) {
    return "No memories found for this user.";
  }

  // Format memories as numbered context
  const context = rows
    .map((row, i) => {
      const parsed = JSON.parse(row.data);
      const content =
        parsed.content || parsed.value || parsed.title || parsed.description || parsed.name || "";
      return `[${i + 1}] (${row.type}, importance: ${row.importance.toFixed(1)}) ${content}`;
    })
    .join("\n");

  const modelId = config?.model || process.env.DEFAULT_MODEL || "auto:free";
  const runtime = config?.runtime || "openrouter";

  try {
    const model = createModel({
      name: runtime as "ollama" | "lmstudio" | "openrouter",
      model: modelId,
      apiKey: config?.apiKey,
    });

    const { text } = await generateText({
      model,
      prompt: `You have access to the following memories about a user/agent. Answer the question based ONLY on these memories. Do not speculate beyond what the data shows. If the memories don't contain enough information to answer, say so.

MEMORIES:
${context}

QUESTION: ${question}

ANSWER:`,
    });

    return text.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Could not analyze memories: ${message}`;
  }
}
