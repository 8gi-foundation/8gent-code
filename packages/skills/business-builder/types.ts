// ── Business Builder — Types ──────────────────────────────────────────────

export type BuildDepth = "quick" | "standard" | "deep";

export interface BusinessIdea {
  description: string;
  depth: BuildDepth;
  model: string;
}

export interface AgentOutput {
  agentId: string;
  role: string;
  summary: string;
  outputs: Record<string, string>;
  recommendations: string[];
  risks: string[];
  completedAt: Date;
}

export interface BusinessBlueprint {
  idea: string;
  agents: Record<string, AgentOutput>;
  summary: string;
  nextSteps: string[];
  estimatedCosts: { monthly: string; startup: string };
  timeline: string;
  risks: string[];
  completedAt: Date;
}

export interface BuildOptions {
  depth?: BuildDepth;
  model?: string;
  parallel?: boolean;
  onProgress?: (phase: number, agentId: string, status: "start" | "done") => void;
}
