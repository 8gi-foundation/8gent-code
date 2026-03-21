/**
 * 8gent - Client Outreach
 *
 * Composes professional responses for GitHub issues, PR descriptions,
 * and direct outreach based on discovered opportunities.
 *
 * Pattern from: Paperclip goal-aligned agents - every communication
 * traces back to the company mission. Agents speak with intent.
 */

import type { Opportunity } from "./opportunity-scanner.ts";
import type { Deliverable } from "./deliverable-generator.ts";

// -- Templates --------------------------------------------------------------

const ISSUE_RESPONSE_TEMPLATES: Record<Opportunity["estimatedEffort"], string> = {
  trivial: "Hi! I'd like to take a crack at this. Should be a quick fix - I'll have a PR up shortly.",
  small:   "Hi! This looks like something I can help with. I'll investigate and open a PR with a solution.",
  medium:  "Hi! I've reviewed this issue and have a clear approach. I'll work on a PR - estimated a few hours. Happy to discuss the approach first if helpful.",
  large:   "Hi! I've read through this carefully. Before diving in, I'd like to discuss the approach - want to make sure the solution aligns with your architecture. Mind if I ask a couple of clarifying questions?",
};

// -- Public API -------------------------------------------------------------

/**
 * Compose a professional GitHub issue comment for claiming/responding to an opportunity.
 */
export function composeResponse(
  opportunity: Opportunity,
  deliverable: Deliverable
): string {
  const base = ISSUE_RESPONSE_TEMPLATES[opportunity.estimatedEffort] ??
    ISSUE_RESPONSE_TEMPLATES.medium;

  const techNote = deliverable.files.length > 0
    ? `\n\nI'll be working in: ${deliverable.files.join(", ")}`
    : "";

  const effortNote = `\n\nEstimated time: ${deliverable.estimatedTime}.`;

  return `${base}${techNote}${effortNote}`;
}

/**
 * Compose a structured PR description for a completed deliverable.
 */
export function composePRDescription(deliverable: Deliverable): string {
  const typeLabels: Record<Deliverable["type"], string> = {
    "pull-request":  "Change",
    "bug-fix":       "Bug Fix",
    "documentation": "Documentation",
    "code-review":   "Review",
    "feature":       "Feature",
  };

  const label = typeLabels[deliverable.type] ?? "Change";

  return `## ${label}

${deliverable.description}

### Files Changed
${deliverable.files.map((f) => `- \`${f}\``).join("\n")}

### Testing
- [ ] Compiles without errors
- [ ] Existing tests pass
- [ ] Manually verified the change works as expected

### Notes
Estimated effort: ${deliverable.estimatedTime}
Opportunity ref: ${deliverable.opportunityId}
`;
}

/**
 * Compose a brief outreach message for a potential client or maintainer.
 * Used when reaching out proactively (e.g., a repo with open TODOs).
 */
export function composeProactiveOutreach(
  opportunity: Opportunity,
  angle: "contribution" | "fix" | "improvement" = "contribution"
): string {
  const repo = opportunity.repo ?? "your project";
  const title = opportunity.title.slice(0, 60);

  const openers: Record<typeof angle, string> = {
    contribution: `I came across ${repo} and noticed "${title}" - I think I can help with this.`,
    fix:          `I spotted a potential fix for "${title}" in ${repo} while exploring the codebase.`,
    improvement:  `While reviewing ${repo}, I found an opportunity to improve "${title}".`,
  };

  return `${openers[angle]}

I have experience with ${opportunity.labels.slice(0, 3).join(", ") || "the relevant technologies"} and could open a PR. Let me know if you'd welcome a contribution.`;
}
