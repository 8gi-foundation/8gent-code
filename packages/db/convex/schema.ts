/**
 * @8gent/db — Convex Schema
 *
 * Database schema for 8gent Code cloud features:
 * - users: Identity from Clerk/GitHub OAuth
 * - sessions: Individual coding session records
 * - usage: Daily usage rollups for analytics and billing
 * - preferences: User preferences synced across machines
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ============================================
  // Users — Core identity from Clerk + GitHub OAuth
  // ============================================
  users: defineTable({
    /** Clerk user ID (the `sub` claim in the JWT). */
    clerkId: v.string(),
    /** Primary email address. */
    email: v.string(),
    /** GitHub username from OAuth. */
    githubUsername: v.string(),
    /** Display name (GitHub profile name). */
    displayName: v.string(),
    /** GitHub avatar URL. */
    avatar: v.string(),
    /** Subscription plan tier. */
    plan: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("team"),
    ),
    /** Account creation timestamp (Unix ms). */
    createdAt: v.number(),
    /** Last activity timestamp (Unix ms). Updated on each session start. */
    lastActiveAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_githubUsername", ["githubUsername"]),

  // ============================================
  // Sessions — Individual coding session records
  // ============================================
  sessions: defineTable({
    /** Reference to the user who owns this session. */
    userId: v.id("users"),
    /** Session start timestamp (Unix ms). */
    startedAt: v.number(),
    /** Session end timestamp (Unix ms). Absent for active/crashed sessions. */
    endedAt: v.optional(v.number()),
    /** Model used (e.g., "qwen3:14b", "gpt-4o"). */
    model: v.string(),
    /** Provider (e.g., "ollama", "openrouter"). */
    provider: v.string(),
    /** Total input tokens consumed. */
    tokensIn: v.number(),
    /** Total output tokens generated. */
    tokensOut: v.number(),
    /** Total tool invocations in this session. */
    toolCalls: v.number(),
    /** Optional benchmark scores recorded during session. */
    benchmarkScores: v.optional(
      v.record(v.string(), v.number()),
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_startedAt", ["userId", "startedAt"]),

  // ============================================
  // Usage — Daily aggregated usage rollups
  // ============================================
  usage: defineTable({
    /** Reference to the user. */
    userId: v.id("users"),
    /** Date string in YYYY-MM-DD format (UTC). */
    date: v.string(),
    /** Total input tokens for the day. */
    tokensIn: v.number(),
    /** Total output tokens for the day. */
    tokensOut: v.number(),
    /** Number of sessions started on this day. */
    sessions: v.number(),
    /** Distinct models used on this day. */
    models: v.array(v.string()),
  })
    .index("by_userId_date", ["userId", "date"]),

  // ============================================
  // Tenants — Multi-tenant configuration
  // ============================================
  tenants: defineTable({
    /** Internal tenant ID (matches user's Convex _id as string). */
    tenantId: v.string(),
    /** Clerk user ID. */
    clerkId: v.string(),
    /** Subdomain slug (e.g., "james" for james.8gent.app). */
    subdomain: v.string(),
    /** Current billing plan. */
    plan: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("team"),
    ),
    /** Usage limits for the current plan. */
    limits: v.object({
      tokensPerDay: v.number(),
      maxConcurrentSessions: v.number(),
      maxTeamMembers: v.number(),
      loraEnabled: v.boolean(),
    }),
    /** Feature flags for this tenant. */
    features: v.object({
      customModels: v.boolean(),
      priorityQueue: v.boolean(),
      benchmarks: v.boolean(),
      apiAccess: v.boolean(),
    }),
    /** Tenant creation timestamp (Unix ms). */
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_clerkId", ["clerkId"])
    .index("by_subdomain", ["subdomain"])
    .index("by_plan", ["plan"]),

  // ============================================
  // Preferences — Synced across machines
  // ============================================
  preferences: defineTable({
    /** Reference to the user. */
    userId: v.id("users"),
    /** Default model (e.g., "qwen3:14b"). Empty string = no preference. */
    defaultModel: v.string(),
    /** Default provider (e.g., "ollama", "openrouter"). */
    defaultProvider: v.string(),
    /** UI theme name. */
    theme: v.string(),
    /** Status of personal LoRA fine-tuning. */
    loraStatus: v.union(
      v.literal("none"),
      v.literal("training"),
      v.literal("ready"),
    ),
    /** LoRA version identifier (e.g., "eight-1.0-q3:14b"). */
    loraVersion: v.optional(v.string()),
    /** Custom prompt mutations the user has configured. */
    customPromptMutations: v.array(v.string()),
    /** Last update timestamp (Unix ms). */
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),
});
