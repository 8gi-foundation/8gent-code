// ── Business Builder — Public API ─────────────────────────────────────────
// Eight spins up a 10-agent org to produce a complete business blueprint.
// Inspired by Durable 2.0 (https://durable.com) — rebuilt as an orchestration
// skill, not a website.

export { buildBusiness } from "./orchestrator.ts";
export { AGENT_DEFS, AGENT_MAP } from "./agents.ts";
export type { BusinessBlueprint, AgentOutput, BusinessIdea, BuildOptions, BuildDepth } from "./types.ts";
