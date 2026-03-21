/**
 * 8gent - Deliverable Generator
 *
 * Plans and tracks concrete deliverables for accepted opportunities.
 * Estimates effort, generates work plans, and manages delivery status.
 *
 * Pattern from: Paperclip heartbeat cycle - agents wake, check assigned work,
 * plan next action, execute, report back. Each unit of work is a Deliverable.
 */

import type { Opportunity } from "./opportunity-scanner.ts";

export interface Deliverable {
  opportunityId: string;
  type: "pull-request" | "code-review" | "documentation" | "bug-fix" | "feature";
  description: string;
  files: string[];
  estimatedTime: string;
  status: "planned" | "in-progress" | "ready" | "submitted";
  createdAt: string;
}

// -- Effort estimation ------------------------------------------------------

const EFFORT_TABLE: Record<Opportunity["estimatedEffort"], { hours: number; complexity: string }> = {
  trivial: { hours: 0.5, complexity: "trivial" },
  small:   { hours: 2,   complexity: "low" },
  medium:  { hours: 6,   complexity: "medium" },
  large:   { hours: 16,  complexity: "high" },
};

/**
 * Estimate work effort for an opportunity.
 */
export function estimateEffort(opportunity: Opportunity): { hours: number; complexity: string } {
  return EFFORT_TABLE[opportunity.estimatedEffort] ?? { hours: 4, complexity: "unknown" };
}

// -- Type inference ---------------------------------------------------------

function inferDeliverableType(opp: Opportunity): Deliverable["type"] {
  const text = `${opp.title} ${opp.description} ${opp.labels.join(" ")}`.toLowerCase();

  if (text.match(/doc|readme|wiki|typo|spelling/)) return "documentation";
  if (text.match(/bug|fix|crash|error|broken|regression/)) return "bug-fix";
  if (text.match(/review|feedback|audit/)) return "code-review";
  if (text.match(/feature|add|implement|support|new/)) return "feature";
  return "pull-request";
}

function inferAffectedFiles(opp: Opportunity): string[] {
  const text = `${opp.title} ${opp.description}`.toLowerCase();
  const files: string[] = [];

  if (text.match(/readme|docs?|documentation/)) files.push("README.md", "docs/");
  if (text.match(/test|spec/)) files.push("tests/", "*.test.ts");
  if (text.match(/config|settings|env/)) files.push("config/", ".env.example");
  if (text.match(/api|endpoint|route/)) files.push("src/routes/", "src/api/");
  if (text.match(/ui|component|style/)) files.push("src/components/");
  if (text.match(/type|interface|schema/)) files.push("src/types/");

  if (files.length === 0) files.push("src/");

  return files.slice(0, 4);
}

// -- Public API -------------------------------------------------------------

/**
 * Plan a deliverable for a given opportunity.
 * Returns a structured work plan without executing anything.
 */
export function planDeliverable(opportunity: Opportunity): Deliverable {
  const type = inferDeliverableType(opportunity);
  const effort = estimateEffort(opportunity);
  const files = inferAffectedFiles(opportunity);

  const timeStr = effort.hours < 1
    ? `~${Math.round(effort.hours * 60)} minutes`
    : `~${effort.hours} hours`;

  const description = buildDeliverableDescription(type, opportunity);

  return {
    opportunityId: opportunity.id,
    type,
    description,
    files,
    estimatedTime: timeStr,
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

function buildDeliverableDescription(type: Deliverable["type"], opp: Opportunity): string {
  const base = opp.title.slice(0, 80);
  const approach = {
    "pull-request":  `Open a PR addressing: ${base}`,
    "bug-fix":       `Identify root cause and fix: ${base}`,
    "documentation": `Write/update documentation for: ${base}`,
    "code-review":   `Review and provide feedback on: ${base}`,
    "feature":       `Implement new feature: ${base}`,
  }[type];
  return approach ?? `Deliver: ${base}`;
}

/**
 * Advance a deliverable's status.
 */
export function advanceDeliverable(
  deliverable: Deliverable,
  status: Deliverable["status"]
): Deliverable {
  return { ...deliverable, status };
}

/**
 * Check if a deliverable is actionable given current agent capabilities.
 * Returns true if the estimated effort is within the feasible range.
 */
export function isActionable(deliverable: Deliverable, maxHours = 8): boolean {
  const effort = Object.values(EFFORT_TABLE).find(
    (e) => deliverable.estimatedTime.includes(String(e.hours))
  );
  return effort ? effort.hours <= maxHours : true;
}
