/**
 * Auto-commit message generation
 * Uses the current model to generate conventional commit messages from diffs.
 */

import { generateText } from "ai";
import { createModel } from "../ai/providers";
import { loadRouterConfig } from "../ai/task-router";

export async function autoCommitMessage(diff: string): Promise<string> {
  if (!diff.trim()) return "chore: empty commit";

  const config = loadRouterConfig();
  const model = createModel({
    name: config.defaultModel.provider,
    model: config.defaultModel.model,
  });

  const { text } = await generateText({
    model,
    prompt: `Generate a single-line conventional commit message for this diff. Format: type(scope): description. Types: feat, fix, refactor, docs, chore, test, style. Be concise.\n\nDiff:\n${diff.slice(0, 3000)}`,
    maxTokens: 100,
  });

  // Clean up - take first line, remove quotes
  return text.trim().split("\n")[0].replace(/^["']|["']$/g, "");
}
