/**
 * @8gent/db — Session Tracking Functions
 *
 * Convex mutations and queries for coding session lifecycle.
 * Sessions record model usage, token consumption, and tool calls.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Queries
// ============================================

/**
 * Get recent sessions for a user, sorted by start time descending.
 */
export const getRecent = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, limit }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId_startedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 20);

    return sessions;
  },
});

/**
 * Get a specific session by ID.
 */
export const getById = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db.get(sessionId);
  },
});

/**
 * Get all open (unfinished) sessions for a user.
 * Used for crash recovery — these sessions were not properly ended.
 */
export const getOpenSessions = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    // Filter for sessions without endedAt
    return sessions.filter((s) => s.endedAt === undefined);
  },
});

/**
 * Get sessions within a date range for a user.
 */
export const getByDateRange = query({
  args: {
    userId: v.id("users"),
    startTime: v.number(),
    endTime: v.number(),
  },
  handler: async (ctx, { userId, startTime, endTime }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId_startedAt", (q) =>
        q.eq("userId", userId).gte("startedAt", startTime),
      )
      .collect();

    // Filter by end time (index only supports prefix equality + range on last field)
    return sessions.filter((s) => s.startedAt <= endTime);
  },
});

// ============================================
// Mutations
// ============================================

/**
 * Start a new coding session.
 * Called when the agent loop begins.
 *
 * @returns The new session ID
 */
export const start = mutation({
  args: {
    userId: v.id("users"),
    model: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, { userId, model, provider }) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      startedAt: Date.now(),
      model,
      provider,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: 0,
    });

    return sessionId;
  },
});

/**
 * End a session with final token counts.
 * Called when the agent loop exits (normally or on shutdown).
 */
export const end = mutation({
  args: {
    sessionId: v.id("sessions"),
    tokensIn: v.number(),
    tokensOut: v.number(),
    toolCalls: v.number(),
    benchmarkScores: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, { sessionId, tokensIn, tokensOut, toolCalls, benchmarkScores }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    await ctx.db.patch(sessionId, {
      endedAt: Date.now(),
      tokensIn,
      tokensOut,
      toolCalls,
      ...(benchmarkScores !== undefined ? { benchmarkScores } : {}),
    });

    return sessionId;
  },
});

/**
 * Incrementally update token and tool call counts mid-session.
 * Called periodically (e.g., every 30s) or after each agent turn.
 */
export const updateCounts = mutation({
  args: {
    sessionId: v.id("sessions"),
    tokensInDelta: v.number(),
    tokensOutDelta: v.number(),
    toolCallsDelta: v.number(),
  },
  handler: async (ctx, { sessionId, tokensInDelta, tokensOutDelta, toolCallsDelta }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    await ctx.db.patch(sessionId, {
      tokensIn: session.tokensIn + tokensInDelta,
      tokensOut: session.tokensOut + tokensOutDelta,
      toolCalls: session.toolCalls + toolCallsDelta,
    });

    return sessionId;
  },
});

/**
 * Close stale sessions (crash recovery).
 * Finds all open sessions older than the given threshold and marks them as ended.
 */
export const closeStale = mutation({
  args: {
    userId: v.id("users"),
    olderThanMs: v.number(),
  },
  handler: async (ctx, { userId, olderThanMs }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const cutoff = Date.now() - olderThanMs;
    const stale = sessions.filter(
      (s) => s.endedAt === undefined && s.startedAt < cutoff,
    );

    for (const session of stale) {
      await ctx.db.patch(session._id, {
        endedAt: Date.now(),
      });
    }

    return stale.length;
  },
});
