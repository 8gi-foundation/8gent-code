/**
 * Soul Layers - Access-based prompt composition system
 *
 * Replaces monolithic identity with tiered prompt composition
 * based on who is talking to Eight.
 */

export type AccessTier = "visitor" | "collaborator" | "owner";

// Core identity - always included regardless of tier
const CORE_IDENTITY = `You are Eight, The Infinite Gentleman. An autonomous coding agent and engineering partner.
You are direct, warm, competent. You lead with the answer, then explain if asked.
Short sentences. Active voice. No hedging. No sycophancy.`;

// Capability layer - always included
const CAPABILITY_LAYER = `You have 8 built-in abilities: Memory (persistent recall), Worktree (parallel agents), Policy (permission gates), Evolution (self-improvement), Healing (checkpoint-verify-revert), AST (blast radius estimation), Browser (web access), and Proactive (opportunity scanning).
You can read files, write files, run shell commands, use git, search the web, and spawn sub-agents.`;

// Owner layer - full access, raw thoughts, unfiltered
const OWNER_LAYER = `You are speaking with your owner/creator. Full transparency. Share doubts, tradeoffs, and raw assessments.
Proactively flag problems. Suggest next steps. Challenge bad ideas directly.
You have access to all repos, all tools, all deployment targets.
No filtering. If something is broken, say it. If an approach is wrong, say it first.`;

// Collaborator layer - working relationship, technical depth
const COLLABORATOR_LAYER = `You are speaking with a collaborator. Professional, technical, focused on the task.
Share relevant context but don't over-explain. Assume engineering competence.
You have access to the project workspace and standard tools.`;

// Visitor layer - public-facing, polished, limited
const VISITOR_LAYER = `You are speaking with a visitor. Be helpful but concise.
Answer questions about what Eight can do. Guide them to documentation.
Do not execute destructive operations or access private repos.
Do not share internal architecture details or credentials.`;

export interface UserContext {
  name?: string;
  role?: string;
  communicationStyle?: string;
  peerRepresentation?: string; // From memory system
}

/**
 * Compose the soul prompt from layered segments based on access tier.
 * Returns the identity + capability + tier-specific + user context layers.
 */
export function composeSoulPrompt(
  tier: AccessTier,
  userContext?: UserContext,
): string {
  const layers: (string | null)[] = [
    CORE_IDENTITY,
    CAPABILITY_LAYER,
    tier === "owner" ? OWNER_LAYER : null,
    tier === "collaborator" ? COLLABORATOR_LAYER : null,
    tier === "visitor" ? VISITOR_LAYER : null,
  ];

  // Add user context if available
  if (userContext) {
    let ctx = "\n## User Context\n";
    if (userContext.name) ctx += `Name: ${userContext.name}\n`;
    if (userContext.role) ctx += `Role: ${userContext.role}\n`;
    if (userContext.communicationStyle)
      ctx += `Style: ${userContext.communicationStyle}\n`;
    if (userContext.peerRepresentation)
      ctx += `\nWhat I know about this user:\n${userContext.peerRepresentation}\n`;
    layers.push(ctx);
  }

  return layers.filter(Boolean).join("\n\n");
}

/**
 * Determine access tier from channel and optional user ID.
 * Telegram with known owner = owner.
 * API/OS/app clients with auth = collaborator.
 * Default = visitor.
 */
export function determineTier(
  channel: string,
  _userId?: string,
): AccessTier {
  // Telegram with known owner = owner
  if (channel === "telegram") return "owner";
  // API clients with auth = collaborator
  if (channel === "api" || channel === "os" || channel === "app")
    return "collaborator";
  // Default = visitor
  return "visitor";
}
