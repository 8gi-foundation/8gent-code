/**
 * @8gent/db — Usage Aggregation Functions
 *
 * Daily usage rollups for analytics and billing.
 * Aggregates session data into per-day summaries.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Queries
// ============================================

/**
 * Get usage for a specific date.
 */
export const getDaily = query({
  args: {
    userId: v.id("users"),
    date: v.string(), // YYYY-MM-DD
  },
  handler: async (ctx, { userId, date }) => {
    return await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", userId).eq("date", date),
      )
      .unique();
  },
});

/**
 * Get usage for a date range (inclusive).
 * Returns records sorted by date ascending.
 */
export const getRange = query({
  args: {
    userId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD
    endDate: v.string(), // YYYY-MM-DD
  },
  handler: async (ctx, { userId, startDate, endDate }) => {
    const records = await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", userId).gte("date", startDate),
      )
      .collect();

    // Filter by end date and sort
    return records
      .filter((r) => r.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

/**
 * Get a monthly summary (sum of all days in the month).
 */
export const getMonthlySummary = query({
  args: {
    userId: v.id("users"),
    yearMonth: v.string(), // YYYY-MM
  },
  handler: async (ctx, { userId, yearMonth }) => {
    const startDate = `${yearMonth}-01`;
    const endDate = `${yearMonth}-31`; // Safe — we filter below

    const records = await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", userId).gte("date", startDate),
      )
      .collect();

    const monthRecords = records.filter(
      (r) => r.date <= endDate && r.date.startsWith(yearMonth),
    );

    // Aggregate
    const allModels = new Set<string>();
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalSessions = 0;

    for (const record of monthRecords) {
      totalTokensIn += record.tokensIn;
      totalTokensOut += record.tokensOut;
      totalSessions += record.sessions;
      for (const model of record.models) {
        allModels.add(model);
      }
    }

    return {
      yearMonth,
      totalTokensIn,
      totalTokensOut,
      totalSessions,
      uniqueModels: Array.from(allModels).sort(),
      days: monthRecords.length,
    };
  },
});

// ============================================
// Mutations
// ============================================

/**
 * Record or update daily usage.
 *
 * This is idempotent — calling it multiple times with the same data
 * will produce the correct aggregate (it adds to existing values).
 *
 * @param tokensIn - Tokens to add to the daily total
 * @param tokensOut - Tokens to add to the daily total
 * @param sessionCount - Sessions to add (usually 1 when a session ends)
 * @param model - Model used (added to the distinct set)
 */
export const recordDaily = mutation({
  args: {
    userId: v.id("users"),
    date: v.string(),
    tokensIn: v.number(),
    tokensOut: v.number(),
    sessionCount: v.number(),
    model: v.string(),
  },
  handler: async (ctx, { userId, date, tokensIn, tokensOut, sessionCount, model }) => {
    // Check for existing record
    const existing = await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", userId).eq("date", date),
      )
      .unique();

    if (existing) {
      // Update existing record
      const models = existing.models.includes(model)
        ? existing.models
        : [...existing.models, model];

      await ctx.db.patch(existing._id, {
        tokensIn: existing.tokensIn + tokensIn,
        tokensOut: existing.tokensOut + tokensOut,
        sessions: existing.sessions + sessionCount,
        models,
      });

      return existing._id;
    }

    // Create new record
    const recordId = await ctx.db.insert("usage", {
      userId,
      date,
      tokensIn,
      tokensOut,
      sessions: sessionCount,
      models: [model],
    });

    return recordId;
  },
});

// ============================================
// Helpers
// ============================================

/**
 * Get today's date string in YYYY-MM-DD format (UTC).
 * Utility used by callers, not a Convex function.
 */
export function getTodayDateString(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/**
 * Get the current year-month string in YYYY-MM format (UTC).
 */
export function getCurrentYearMonth(): string {
  const now = new Date();
  return now.toISOString().slice(0, 7);
}
