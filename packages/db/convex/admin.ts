/**
 * @8gent/db — Admin-Only Convex Functions
 *
 * Aggregate queries for the admin dashboard.
 * All functions require admin role verification via Clerk JWT.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";

// ============================================
// Auth Helper
// ============================================

/**
 * Verify the caller has admin role.
 * Reads `publicMetadata.role` from the Clerk JWT claims.
 * Throws if not authenticated or not an admin.
 */
async function requireAdmin(ctx: { auth: { getUserIdentity: () => Promise<any> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized: not authenticated");
  }

  // Clerk stores publicMetadata in the JWT custom claims
  // The role field is set via Clerk dashboard or API
  const role = (identity as any).publicMetadata?.role ?? (identity as any).role;
  if (role !== "admin") {
    throw new Error("Forbidden: admin role required");
  }

  return identity;
}

// ============================================
// Dashboard Aggregates
// ============================================

/**
 * Get aggregate stats for the admin dashboard.
 * Returns user count, active sessions, today's token usage, and plan distribution.
 */
export const getAdminDashboard = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    // Total users
    const allUsers = await ctx.db.query("users").collect();
    const userCount = allUsers.length;

    // Plan distribution
    const planDistribution = { free: 0, pro: 0, team: 0 };
    for (const user of allUsers) {
      planDistribution[user.plan as keyof typeof planDistribution]++;
    }

    // Active sessions (no endedAt)
    const allSessions = await ctx.db.query("sessions").collect();
    const activeSessions = allSessions.filter((s) => s.endedAt === undefined);
    const activeSessionCount = activeSessions.length;

    // Today's token usage
    const today = new Date().toISOString().slice(0, 10);
    const allUsage = await ctx.db.query("usage").collect();
    const todayUsage = allUsage.filter((u) => u.date === today);
    let tokensToday = 0;
    for (const record of todayUsage) {
      tokensToday += record.tokensIn + record.tokensOut;
    }

    // User creation dates for growth chart
    const userCreationDates = allUsers.map((u) => u.createdAt);

    return {
      userCount,
      activeSessionCount,
      tokensToday,
      planDistribution,
      userCreationDates,
    };
  },
});

/**
 * Get paginated user list with usage stats.
 */
export const getUserList = query({
  args: {
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    search: v.optional(v.string()),
    planFilter: v.optional(
      v.union(v.literal("free"), v.literal("pro"), v.literal("team")),
    ),
  },
  handler: async (ctx, { limit = 50, offset = 0, search, planFilter }) => {
    await requireAdmin(ctx);

    let users = await ctx.db.query("users").collect();

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      users = users.filter(
        (u) =>
          u.displayName.toLowerCase().includes(searchLower) ||
          u.email.toLowerCase().includes(searchLower) ||
          u.githubUsername.toLowerCase().includes(searchLower),
      );
    }

    // Apply plan filter
    if (planFilter) {
      users = users.filter((u) => u.plan === planFilter);
    }

    // Sort by last active (most recent first)
    users.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const totalCount = users.length;
    const paginatedUsers = users.slice(offset, offset + limit);

    // Fetch usage stats for each user in the page
    const usersWithStats = await Promise.all(
      paginatedUsers.map(async (user) => {
        // Get total usage for this user
        const usageRecords = await ctx.db
          .query("usage")
          .withIndex("by_userId_date", (q) => q.eq("userId", user._id))
          .collect();

        let totalTokensIn = 0;
        let totalTokensOut = 0;
        let totalSessions = 0;

        for (const record of usageRecords) {
          totalTokensIn += record.tokensIn;
          totalTokensOut += record.tokensOut;
          totalSessions += record.sessions;
        }

        // Get active session count
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .collect();
        const activeSessionCount = sessions.filter(
          (s) => s.endedAt === undefined,
        ).length;

        return {
          ...user,
          totalTokensIn,
          totalTokensOut,
          totalSessions,
          activeSessionCount,
        };
      }),
    );

    return {
      users: usersWithStats,
      totalCount,
      hasMore: offset + limit < totalCount,
    };
  },
});

/**
 * Get system health metrics.
 * Active sessions, error rates, model distribution, provider distribution.
 */
export const getSystemHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const allSessions = await ctx.db.query("sessions").collect();

    const activeSessions = allSessions.filter((s) => s.endedAt === undefined).length;
    const sessionsLastHour = allSessions.filter((s) => s.startedAt >= oneHourAgo).length;

    // Stale sessions (started > 2hr ago, never ended) indicate crashes
    const staleSessions = allSessions.filter(
      (s) => s.endedAt === undefined && s.startedAt < twoHoursAgo,
    ).length;
    const completedSessions = allSessions.filter((s) => s.endedAt !== undefined).length;
    const errorRate =
      completedSessions + staleSessions > 0
        ? staleSessions / (completedSessions + staleSessions)
        : 0;

    // Model distribution (last 30 days)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recentSessions = allSessions.filter((s) => s.startedAt >= thirtyDaysAgo);

    const modelDistribution: Record<string, number> = {};
    const providerDistribution: Record<string, number> = {};
    let totalDuration = 0;
    let completedCount = 0;

    for (const session of recentSessions) {
      modelDistribution[session.model] = (modelDistribution[session.model] ?? 0) + 1;
      providerDistribution[session.provider] = (providerDistribution[session.provider] ?? 0) + 1;

      if (session.endedAt) {
        totalDuration += session.endedAt - session.startedAt;
        completedCount++;
      }
    }

    const avgSessionDuration = completedCount > 0 ? Math.round(totalDuration / completedCount) : 0;

    return {
      activeSessions,
      sessionsLastHour,
      staleSessions,
      errorRate: Math.round(errorRate * 10000) / 10000, // 4 decimal places
      modelDistribution,
      providerDistribution,
      avgSessionDuration,
      totalSessions: allSessions.length,
    };
  },
});

/**
 * Get usage timeseries data for charting.
 * Returns daily aggregated token usage for the last N days across all users.
 */
export const getUsageTimeseries = query({
  args: {
    days: v.optional(v.number()),
  },
  handler: async (ctx, { days = 30 }) => {
    await requireAdmin(ctx);

    const allUsage = await ctx.db.query("usage").collect();

    // Aggregate by date across all users
    const dailyTotals = new Map<
      string,
      { tokensIn: number; tokensOut: number; sessions: number; uniqueUsers: Set<string> }
    >();

    for (const record of allUsage) {
      const existing = dailyTotals.get(record.date) ?? {
        tokensIn: 0,
        tokensOut: 0,
        sessions: 0,
        uniqueUsers: new Set<string>(),
      };
      existing.tokensIn += record.tokensIn;
      existing.tokensOut += record.tokensOut;
      existing.sessions += record.sessions;
      existing.uniqueUsers.add(record.userId as string);
      dailyTotals.set(record.date, existing);
    }

    // Build timeseries for the last N days
    const now = new Date();
    const timeseries: Array<{
      date: string;
      tokensIn: number;
      tokensOut: number;
      totalTokens: number;
      sessions: number;
      activeUsers: number;
    }> = [];

    for (let i = days; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);

      const data = dailyTotals.get(dateStr);
      timeseries.push({
        date: dateStr,
        tokensIn: data?.tokensIn ?? 0,
        tokensOut: data?.tokensOut ?? 0,
        totalTokens: (data?.tokensIn ?? 0) + (data?.tokensOut ?? 0),
        sessions: data?.sessions ?? 0,
        activeUsers: data?.uniqueUsers.size ?? 0,
      });
    }

    return timeseries;
  },
});

/**
 * Get recent sessions across all users for the admin session monitor.
 */
export const getRecentSessions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit = 50 }) => {
    await requireAdmin(ctx);

    const sessions = await ctx.db.query("sessions").order("desc").take(limit);

    // Enrich with user info
    const enriched = await Promise.all(
      sessions.map(async (session) => {
        const user = await ctx.db.get(session.userId);
        return {
          ...session,
          userDisplayName: user?.displayName ?? "Unknown",
          userGithubUsername: user?.githubUsername ?? "unknown",
          userAvatar: user?.avatar ?? "",
        };
      }),
    );

    return enriched;
  },
});

/**
 * Get a single user's details with full stats (for user detail page).
 */
export const getUserDetail = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);

    const user = await ctx.db.get(userId);
    if (!user) return null;

    // Get all sessions
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId_startedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);

    // Get usage records
    const usageRecords = await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) => q.eq("userId", userId))
      .collect();

    // Get preferences
    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    // Compute aggregates
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalSessions = 0;
    const models = new Set<string>();

    for (const record of usageRecords) {
      totalTokensIn += record.tokensIn;
      totalTokensOut += record.tokensOut;
      totalSessions += record.sessions;
      for (const model of record.models) {
        models.add(model);
      }
    }

    const activeSessions = sessions.filter((s) => s.endedAt === undefined).length;

    return {
      user,
      sessions,
      usageRecords: usageRecords.sort((a, b) => a.date.localeCompare(b.date)),
      preferences,
      stats: {
        totalTokensIn,
        totalTokensOut,
        totalSessions,
        activeSessions,
        uniqueModels: Array.from(models),
      },
    };
  },
});
