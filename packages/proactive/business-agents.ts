/**
 * 8gent - Business Agent System
 *
 * Defines the 10 business agent roles and 5-phase scoping pipeline.
 * This is the executable backend for 8gent.world/business - not just data,
 * but the logic that activates agents, sequences phases, and generates prompts.
 */

// -- Types -------------------------------------------------------------------

export type BusinessAgentRole =
  | "strategy" | "operations" | "marketing" | "sales" | "finance"
  | "legal" | "hr" | "product" | "tech" | "customer";

export type ScopingPhase = {
  phase: number;
  name: string;
  description: string;
  agents: BusinessAgentRole[];
  durationMinutes: number;
};

export type AgentOutput = {
  agentId: BusinessAgentRole;
  phase: number;
  deliverables: string[];
  prompt: string;
};

export type BusinessScope = {
  idea: string;
  phases: ScopingPhase[];
  agentOutputs: AgentOutput[];
  collaborationMap: Record<BusinessAgentRole, BusinessAgentRole[]>;
  estimatedMinutes: number;
};

// -- Agent definitions -------------------------------------------------------

type AgentDef = {
  id: BusinessAgentRole;
  name: string;
  role: string;
  deliverables: string[];
  collaborates: BusinessAgentRole[];
  promptFocus: string;
};

export const BUSINESS_AGENTS: readonly AgentDef[] = [
  {
    id: "strategy", name: "Strategy Agent", role: "Chief Strategist",
    deliverables: ["Business Model Canvas", "Competitive Intel Report", "Revenue Plan", "Growth Roadmap"],
    collaborates: ["finance", "product", "marketing"],
    promptFocus: "business model, competitive landscape, market sizing, revenue streams, and growth vectors",
  },
  {
    id: "operations", name: "Operations Agent", role: "Head of Operations",
    deliverables: ["Operations Playbook", "Workflow Diagrams", "Tool Stack Matrix", "Automation Blueprints"],
    collaborates: ["strategy", "tech", "hr"],
    promptFocus: "process mapping, SOPs, tool selection, automation pipelines, and KPI dashboards",
  },
  {
    id: "marketing", name: "Marketing Agent", role: "Head of Marketing",
    deliverables: ["Brand Guidelines", "Content Strategy", "SEO/AEO Playbook", "Campaign Briefs"],
    collaborates: ["sales", "product", "strategy"],
    promptFocus: "brand identity, content calendar, SEO/AEO optimization, social campaigns, and email sequences",
  },
  {
    id: "sales", name: "Sales Agent", role: "Head of Sales",
    deliverables: ["Sales Playbook", "CRM Configuration", "Outreach Sequences", "Pipeline Dashboard"],
    collaborates: ["marketing", "finance", "customer"],
    promptFocus: "CRM design, lead scoring, outreach sequences, proposal drafts, and revenue forecasting",
  },
  {
    id: "finance", name: "Finance Agent", role: "CFO",
    deliverables: ["Financial Model", "Pricing Matrix", "Cash Flow Projections", "Invoice Templates"],
    collaborates: ["strategy", "sales", "operations"],
    promptFocus: "financial modeling, pricing strategy, burn rate analysis, and bookkeeping workflows",
  },
  {
    id: "legal", name: "Legal Agent", role: "General Counsel",
    deliverables: ["Legal Document Suite", "Compliance Checklist", "Contract Templates", "Risk Assessment"],
    collaborates: ["operations", "hr", "finance"],
    promptFocus: "terms of service, privacy policy, contracts, compliance frameworks, and IP protection",
  },
  {
    id: "hr", name: "People Agent", role: "Head of People",
    deliverables: ["Org Blueprint", "Job Descriptions", "Onboarding Playbook", "Compensation Framework"],
    collaborates: ["operations", "legal", "finance"],
    promptFocus: "org structure, hiring plans, onboarding flows, compensation benchmarks, and culture docs",
  },
  {
    id: "product", name: "Product Agent", role: "Head of Product",
    deliverables: ["Product Roadmap", "Feature Specs", "User Personas", "Prioritization Matrix"],
    collaborates: ["strategy", "tech", "marketing"],
    promptFocus: "product roadmap, feature prioritization, user personas, specs, and feedback loops",
  },
  {
    id: "tech", name: "Tech Agent", role: "CTO",
    deliverables: ["Architecture Diagram", "Tech Stack Decision Doc", "Security Playbook", "Infrastructure Plan"],
    collaborates: ["product", "operations", "strategy"],
    promptFocus: "tech stack selection, infrastructure, CI/CD, security posture, and scalability planning",
  },
  {
    id: "customer", name: "Customer Agent", role: "Head of Customer Success",
    deliverables: ["Support Playbook", "Knowledge Base Structure", "Health Score Model", "Retention Strategy"],
    collaborates: ["sales", "product", "marketing"],
    promptFocus: "support systems, knowledge base, health scoring, retention strategies, and feedback automation",
  },
] as const;

// -- Phase definitions -------------------------------------------------------

export const SCOPING_PHASES: readonly ScopingPhase[] = [
  { phase: 1, name: "Discovery", description: "Strategy agent interviews the operator, analyzes the idea, and produces the master business blueprint.", agents: ["strategy"], durationMinutes: 5 },
  { phase: 2, name: "Architecture", description: "Product, Tech, and Operations scope what to build, how to build it, and how it runs.", agents: ["product", "tech", "operations"], durationMinutes: 10 },
  { phase: 3, name: "Revenue Engine", description: "Marketing, Sales, and Finance design go-to-market, pipeline, pricing, and financial model.", agents: ["marketing", "sales", "finance"], durationMinutes: 10 },
  { phase: 4, name: "Foundation", description: "Legal, People, and Customer Success build the org foundation - contracts, hiring, support.", agents: ["legal", "hr", "customer"], durationMinutes: 8 },
  { phase: 5, name: "Orchestration", description: "All agents sync outputs into a unified business OS. Gaps are flagged, cross-refs validated.", agents: ["strategy", "operations", "marketing", "sales", "finance", "legal", "hr", "product", "tech", "customer"], durationMinutes: 5 },
] as const;

// -- Lookup helpers ----------------------------------------------------------

const agentMap = new Map(BUSINESS_AGENTS.map(a => [a.id, a]));

export function getPhaseAgents(phase: number): BusinessAgentRole[] {
  const p = SCOPING_PHASES.find(sp => sp.phase === phase);
  return p ? [...p.agents] : [];
}

export function getCollaborators(agentId: BusinessAgentRole): BusinessAgentRole[] {
  const agent = agentMap.get(agentId);
  return agent ? [...agent.collaborates] : [];
}

// -- Prompt generation -------------------------------------------------------

export function getAgentPrompt(
  role: BusinessAgentRole,
  context: { idea: string; phase: number; priorOutputs: string[] },
): string {
  const agent = agentMap.get(role);
  if (!agent) return "";

  const phase = SCOPING_PHASES.find(p => p.phase === context.phase);
  const phaseName = phase?.name ?? `Phase ${context.phase}`;

  const prior = context.priorOutputs.length > 0
    ? `\n\nPrior agent outputs to build on:\n${context.priorOutputs.map(o => `- ${o}`).join("\n")}`
    : "";

  return [
    `You are the ${agent.name} (${agent.role}) for a new business.`,
    `Business idea: ${context.idea}`,
    `Current phase: ${phaseName} (${context.phase}/5)`,
    ``,
    `Your focus: ${agent.promptFocus}.`,
    ``,
    `Produce these deliverables:`,
    ...agent.deliverables.map(d => `- ${d}`),
    ``,
    `Be specific to this business. Output actionable content, not generic advice.`,
    `Keep each deliverable concise - bullet points and tables preferred over prose.`,
    prior,
  ].join("\n");
}

// -- Business scoping --------------------------------------------------------

export function scopeBusiness(idea: string): BusinessScope {
  const agentOutputs: AgentOutput[] = [];

  for (const phase of SCOPING_PHASES) {
    for (const agentId of phase.agents) {
      const agent = agentMap.get(agentId);
      if (!agent) continue;

      const priorDeliverables = agentOutputs
        .filter(o => agent.collaborates.includes(o.agentId))
        .flatMap(o => o.deliverables);

      agentOutputs.push({
        agentId,
        phase: phase.phase,
        deliverables: [...agent.deliverables],
        prompt: getAgentPrompt(agentId, { idea, phase: phase.phase, priorOutputs: priorDeliverables }),
      });
    }
  }

  const collaborationMap = Object.fromEntries(
    BUSINESS_AGENTS.map(a => [a.id, [...a.collaborates]]),
  ) as Record<BusinessAgentRole, BusinessAgentRole[]>;

  const estimatedMinutes = SCOPING_PHASES.reduce((sum, p) => sum + p.durationMinutes, 0);

  return { idea, phases: [...SCOPING_PHASES], agentOutputs, collaborationMap, estimatedMinutes };
}
