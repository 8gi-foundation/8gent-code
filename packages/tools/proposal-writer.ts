/**
 * Proposal object structure
 */
interface Proposal {
  executiveSummary: string;
  scope: string;
  timeline: { title: string; date: string }[];
  pricing: { total: number; breakdown: { [key: string]: number } };
  terms: string[];
}

/**
 * Builds a proposal object
 * @param client - Client name
 * @param project - Project name
 * @param phases - Array of project phases
 * @param pricing - Pricing details
 * @param terms - Array of terms
 * @returns Proposal object
 */
function buildProposal({
  client,
  project,
  phases,
  pricing,
  terms,
}: {
  client: string;
  project: string;
  phases: { name: string; cost: number }[];
  pricing: { margin?: number };
  terms: string[];
}): Proposal {
  const summary = `Proposal for ${project} by ${client}`;
  const scope = phases.map(p => `- ${p.name}`).join('\n');
  const timeline = generateTimeline(phases);
  const total = estimateTotalPrice(phases, pricing.margin);
  return {
    executiveSummary: summary,
    scope: scope,
    timeline: timeline,
    pricing: {
      total: total,
      breakdown: phases.reduce(
        (acc, p) => ({ ...acc, [p.name]: p.cost }),
        {}
      ),
    },
    terms: terms,
  };
}

/**
 * Renders proposal as markdown
 * @param proposal - Proposal object
 * @returns Full markdown document
 */
function renderMarkdown(proposal: Proposal): string {
  return `# Proposal\n\n## Executive Summary\n${proposal.executiveSummary}\n\n## Scope\n${proposal.scope}\n\n## Timeline\n${proposal.timeline
    .map(t => `- ${t.title}: ${t.date}`)
    .join('\n')}\n\n## Pricing\nTotal: $${proposal.pricing.total}\nBreakdown:\n${Object.entries(
    proposal.pricing.breakdown
  )
    .map(([k, v]) => `-${k}: $${v}`)
    .join('\n')}\n\n## Terms\n- ${proposal.terms.join('\n- ')}`;
}

/**
 * Estimates total price with optional margin
 * @param phases - Array of phases
 * @param margin - Optional margin percentage
 * @returns Total price
 */
function estimateTotalPrice(
  phases: { cost: number }[],
  margin?: number
): number {
  const base = phases.reduce((sum, p) => sum + p.cost, 0);
  return margin ? base * (1 + margin / 100) : base;
}

/**
 * Generates timeline with ISO dates
 * @param phases - Array of phases
 * @returns Ordered milestones
 */
function generateTimeline(
  phases: { name: string; start: Date; end: Date }[]
): { title: string; date: string }[] {
  return phases
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(p => ({
      title: p.name,
      date: `${p.start.toISOString().split('T')[0]} - ${p.end.toISOString().split('T')[0]}`,
    }));
}

export { buildProposal, renderMarkdown, estimateTotalPrice, generateTimeline };