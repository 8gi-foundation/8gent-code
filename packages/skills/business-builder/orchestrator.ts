// ── Business Builder — Orchestrator ──────────────────────────────────────
// Runs 10 agents in 5 phases. Strategy goes solo first; then parallel phases
// build on its output. Final phase synthesizes a unified blueprint.

import { generateText } from "ai";
import { createModel } from "../../ai/providers.ts";
import { AGENT_MAP } from "./agents.ts";
import type { AgentOutput, BusinessBlueprint, BuildOptions } from "./types.ts";

// Depth -> max tokens per agent call
const DEPTH_TOKENS: Record<string, number> = {
  quick: 600,
  standard: 1200,
  deep: 2400,
};

// Phase definitions: each entry is a list of agent IDs run in parallel
const PHASES: string[][] = [
  ["strategy"],                          // Phase 1: Discovery
  ["product", "tech", "operations"],     // Phase 2: Architecture
  ["marketing", "sales", "finance"],     // Phase 3: Revenue Engine
  ["legal", "hr", "customer"],           // Phase 4: Foundation
];

async function runAgent(
  agentId: string,
  idea: string,
  blueprint: string,
  model: ReturnType<typeof createModel>,
  maxTokens: number,
  onProgress?: BuildOptions["onProgress"],
  phase?: number,
): Promise<AgentOutput> {
  const def = AGENT_MAP.get(agentId);
  if (!def) throw new Error(`Unknown agent: ${agentId}`);

  onProgress?.(phase ?? 0, agentId, "start");

  const prompt = def.promptTemplate
    .replace("{{idea}}", idea)
    .replace("{{blueprint}}", blueprint);

  const { text } = await generateText({ model, prompt, maxTokens });

  // Parse structured sections from the text output
  const lines = text.split("\n");
  const outputs: Record<string, string> = {};
  def.outputs.forEach((label, i) => {
    // Extract content loosely tied to each expected output
    const start = lines.findIndex(l => l.toLowerCase().includes(label.toLowerCase().split(" ")[0]));
    outputs[label] = start >= 0 ? lines.slice(start, start + 5).join("\n").trim() : "(see summary)";
  });

  // Pull risks: lines containing "risk" keyword
  const risks = lines
    .filter(l => /risk|caveat|warn|challeng/i.test(l))
    .slice(0, 3)
    .map(l => l.trim());

  // Recommendations: numbered list items
  const recommendations = lines
    .filter(l => /^\d+\.|^-\s/.test(l.trim()))
    .slice(0, 5)
    .map(l => l.trim());

  onProgress?.(phase ?? 0, agentId, "done");

  return {
    agentId,
    role: def.role,
    summary: text.slice(0, 800),
    outputs,
    recommendations,
    risks,
    completedAt: new Date(),
  };
}

async function synthesize(
  idea: string,
  agentOutputs: Record<string, AgentOutput>,
  model: ReturnType<typeof createModel>,
  maxTokens: number,
): Promise<{ summary: string; nextSteps: string[]; risks: string[]; estimatedCosts: { monthly: string; startup: string }; timeline: string }> {
  const summaries = Object.values(agentOutputs)
    .map(a => `[${a.role}]\n${a.summary.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are orchestrating 10 business agents. Synthesize their outputs into a final business blueprint summary.

Business Idea: ${idea}

Agent Summaries:
${summaries}

Produce:
1. Executive summary (3-5 sentences)
2. Top 5 next steps to launch (numbered, specific)
3. Top 3 risks (numbered)
4. Estimated startup cost (one line, e.g. "$8,000-$15,000")
5. Estimated monthly burn (one line, e.g. "$3,500/month")
6. Launch timeline (one line, e.g. "8-12 weeks to MVP")

Keep it tight. Be specific.`;

  const { text } = await generateText({ model, prompt, maxTokens });

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const nextSteps = lines.filter(l => /^\d+\./.test(l)).slice(0, 5);
  const risks = lines.filter(l => /risk|threat|warn/i.test(l)).slice(0, 3);

  const costMatch = text.match(/\$[\d,]+[-–]?\$?[\d,]+\s*\/?\s*month/i);
  const startupMatch = text.match(/startup[^$]*?\$([\d,k]+[-–]?\$?[\d,k]+)/i) ||
    text.match(/\$([\d,k]+[-–]?\$?[\d,k]+)/i);

  return {
    summary: lines.slice(0, 4).join(" "),
    nextSteps: nextSteps.length ? nextSteps : lines.slice(0, 5),
    risks: risks.length ? risks : ["Market validation needed", "Funding runway risk", "Execution speed vs. competition"],
    estimatedCosts: {
      monthly: costMatch?.[0] ?? "See finance agent",
      startup: startupMatch ? `$${startupMatch[1]}` : "See finance agent",
    },
    timeline: text.match(/(\d+[-–]\d+\s*weeks?|\d+\s*months?)/i)?.[0] ?? "8-12 weeks to MVP",
  };
}

/**
 * Build a complete business blueprint from a single idea string.
 *
 * Inspired by Durable 2.0 — rebuilt as an orchestration pipeline,
 * not a website. See: https://durable.com
 */
export async function buildBusiness(
  idea: string,
  opts: BuildOptions = {},
): Promise<BusinessBlueprint> {
  const depth = opts.depth ?? "standard";
  const modelId = opts.model ?? "llama3.2";
  const parallel = opts.parallel !== false;
  const maxTokens = DEPTH_TOKENS[depth] ?? 1200;
  const onProgress = opts.onProgress;

  const model = createModel({ name: "ollama", model: modelId });
  const agentOutputs: Record<string, AgentOutput> = {};

  // Phases 1-4: Strategy solo, then parallel phases building on it
  for (let i = 0; i < PHASES.length; i++) {
    const phaseAgents = PHASES[i];
    const blueprint = agentOutputs["strategy"]?.summary ?? "";

    if (parallel && phaseAgents.length > 1) {
      const results = await Promise.all(
        phaseAgents.map(id => runAgent(id, idea, blueprint, model, maxTokens, onProgress, i + 1)),
      );
      results.forEach(r => { agentOutputs[r.agentId] = r; });
    } else {
      for (const id of phaseAgents) {
        const result = await runAgent(id, idea, blueprint, model, maxTokens, onProgress, i + 1);
        agentOutputs[result.agentId] = result;
      }
    }
  }

  // Phase 5: Synthesis
  onProgress?.(5, "orchestrator", "start");
  const synthesis = await synthesize(idea, agentOutputs, model, maxTokens);
  onProgress?.(5, "orchestrator", "done");

  return {
    idea,
    agents: agentOutputs,
    summary: synthesis.summary,
    nextSteps: synthesis.nextSteps,
    estimatedCosts: synthesis.estimatedCosts,
    timeline: synthesis.timeline,
    risks: synthesis.risks,
    completedAt: new Date(),
  };
}
