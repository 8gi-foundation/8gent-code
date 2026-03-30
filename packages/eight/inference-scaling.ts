/**
 * 8gent Code - Inference-Time Scaling with Critic Selection
 *
 * Generates multiple solution attempts at elevated temperature,
 * then uses a critic model (via generateObject) to score and
 * select the best response. Implements best-of-N sampling.
 *
 * When attempts === 1 the critic is skipped entirely (pass-through).
 */

import { generateText, generateObject } from "ai";
import { z } from "zod";
import { createModel, type ProviderConfig } from "../ai";

// ── Types ────────────────────────────────────────────────────

export interface ScalingConfig {
  /** How many solutions to generate (default 3) */
  attempts: number;
  /** Model for judging - provider config override (default: same model) */
  criticProvider?: ProviderConfig;
  /** Higher temp for diversity across attempts (default 0.8) */
  temperature?: number;
}

export interface AttemptResult {
  response: string;
  score: number;       // 0-1 from critic
  reasoning: string;   // critic's explanation
}

export interface ScalingResult {
  best: AttemptResult;
  all: AttemptResult[];
}

// ── Critic Schema ────────────────────────────────────────────

const CriticSchema = z.object({
  score: z.number().min(0).max(1).describe(
    "Overall quality score from 0 (terrible) to 1 (excellent)"
  ),
  correctness: z.number().min(0).max(1).describe("Factual and logical correctness"),
  completeness: z.number().min(0).max(1).describe("How thoroughly the prompt was addressed"),
  codeQuality: z.number().min(0).max(1).describe("Code quality if code is present, otherwise 0.5"),
  clarity: z.number().min(0).max(1).describe("How clear and well-structured the response is"),
  reasoning: z.string().describe("One sentence explaining the score"),
});

// ── Core Function ────────────────────────────────────────────

export async function scaleInference(
  prompt: string,
  provider: ProviderConfig,
  systemPrompt?: string,
  config?: Partial<ScalingConfig>,
): Promise<ScalingResult> {
  const attempts = config?.attempts ?? 3;
  const temperature = config?.temperature ?? 0.8;
  const criticProvider = config?.criticProvider ?? provider;

  // Pass-through: single attempt, no critic overhead
  if (attempts <= 1) {
    const model = createModel(provider);
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt,
      temperature: 0.7,
    });
    const single: AttemptResult = { response: result.text, score: 1, reasoning: "Single attempt - no critic" };
    return { best: single, all: [single] };
  }

  // Generate N attempts in parallel with elevated temperature
  const model = createModel(provider);
  const generations = await Promise.all(
    Array.from({ length: attempts }, () =>
      generateText({
        model,
        system: systemPrompt,
        prompt,
        temperature,
      }).then(r => r.text)
    ),
  );

  // Score each attempt with the critic
  const criticModel = createModel(criticProvider);
  const scored: AttemptResult[] = await Promise.all(
    generations.map(async (response) => {
      try {
        const { object } = await (generateObject as Function)({
          model: criticModel,
          schema: CriticSchema,
          prompt: [
            "Rate the quality of this AI response to the given prompt.",
            "",
            "--- PROMPT ---",
            prompt.slice(0, 1000),
            "",
            "--- RESPONSE ---",
            response.slice(0, 3000),
            "",
            "Score each dimension 0-1, then give an overall score.",
          ].join("\n"),
          maxTokens: 200,
        }) as { object: z.infer<typeof CriticSchema> };
        return {
          response,
          score: object.score,
          reasoning: object.reasoning,
        };
      } catch {
        // Critic failed for this attempt - give neutral score
        return { response, score: 0.5, reasoning: "Critic evaluation failed" };
      }
    }),
  );

  // Select best by score (tie-break: first generated wins)
  scored.sort((a, b) => b.score - a.score);

  return { best: scored[0], all: scored };
}
