/**
 * @8gent/control-plane — Analytics
 *
 * Usage analytics, growth metrics, and aggregation functions.
 * These work with data from Convex queries but keep business logic
 * in the control-plane package.
 */

import type {
  DataPoint,
  ReportPeriod,
  UsageReport,
  UserUsageStats,
  SystemHealth,
  PlanTier,
} from "./types";

// ============================================
// Growth Metrics
// ============================================

/**
 * Calculate user growth data points from a list of user creation timestamps.
 * Returns cumulative user count for each day in the period.
 */
export function calculateUserGrowth(
  userCreationDates: number[],
  days: number = 30,
): DataPoint[] {
  const now = new Date();
  const result: DataPoint[] = [];

  // Build a map of date -> new users that day
  const dailyNew = new Map<string, number>();
  for (const ts of userCreationDates) {
    const date = new Date(ts).toISOString().slice(0, 10);
    dailyNew.set(date, (dailyNew.get(date) ?? 0) + 1);
  }

  // Count users created before the period start
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - days);
  const periodStartStr = periodStart.toISOString().slice(0, 10);

  let cumulative = userCreationDates.filter(
    (ts) => new Date(ts).toISOString().slice(0, 10) < periodStartStr,
  ).length;

  // Fill in each day
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    cumulative += dailyNew.get(dateStr) ?? 0;
    result.push({ date: dateStr, value: cumulative });
  }

  return result;
}

/**
 * Calculate active session count from a list of sessions.
 * A session is active if it has no endedAt timestamp.
 */
export function getActiveSessionCount(
  sessions: Array<{ endedAt?: number }>,
): number {
  return sessions.filter((s) => s.endedAt === undefined).length;
}

// ============================================
// Token Usage Analytics
// ============================================

/**
 * Aggregate token usage data points from daily usage records.
 */
export function aggregateTokenUsage(
  usageRecords: Array<{ date: string; tokensIn: number; tokensOut: number }>,
  days: number = 30,
): DataPoint[] {
  const now = new Date();
  const result: DataPoint[] = [];

  // Build a map of date -> total tokens
  const dailyTokens = new Map<string, number>();
  for (const record of usageRecords) {
    const existing = dailyTokens.get(record.date) ?? 0;
    dailyTokens.set(record.date, existing + record.tokensIn + record.tokensOut);
  }

  // Fill in each day (zero-fill missing days)
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    result.push({
      date: dateStr,
      value: dailyTokens.get(dateStr) ?? 0,
    });
  }

  return result;
}

/**
 * Calculate model distribution from session records.
 * Returns a map of model name -> session count.
 */
export function calculateModelDistribution(
  sessions: Array<{ model: string }>,
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const session of sessions) {
    dist[session.model] = (dist[session.model] ?? 0) + 1;
  }
  return dist;
}

/**
 * Calculate provider distribution from session records.
 */
export function calculateProviderDistribution(
  sessions: Array<{ provider: string }>,
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const session of sessions) {
    dist[session.provider] = (dist[session.provider] ?? 0) + 1;
  }
  return dist;
}

/**
 * Calculate plan distribution from user records.
 */
export function calculatePlanDistribution(
  users: Array<{ plan: PlanTier }>,
): Record<PlanTier, number> {
  const dist: Record<PlanTier, number> = { free: 0, pro: 0, team: 0 };
  for (const user of users) {
    dist[user.plan]++;
  }
  return dist;
}

// ============================================
// Usage Report Generation
// ============================================

/**
 * Generate a usage report for a given period.
 */
export function generateUsageReport(
  period: ReportPeriod,
  usageRecords: Array<{
    userId: string;
    date: string;
    tokensIn: number;
    tokensOut: number;
    sessions: number;
    models: string[];
  }>,
): UsageReport {
  const now = new Date();
  let daysBack: number;

  switch (period) {
    case "daily":
      daysBack = 1;
      break;
    case "weekly":
      daysBack = 7;
      break;
    case "monthly":
      daysBack = 30;
      break;
  }

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = now.toISOString().slice(0, 10);

  // Filter to period
  const periodRecords = usageRecords.filter(
    (r) => r.date >= startDateStr && r.date <= endDateStr,
  );

  // Aggregate
  let totalTokens = 0;
  let totalSessions = 0;
  const activeUserSet = new Set<string>();
  const byModel: Record<string, number> = {};
  const dailyMap = new Map<string, number>();

  for (const record of periodRecords) {
    const tokens = record.tokensIn + record.tokensOut;
    totalTokens += tokens;
    totalSessions += record.sessions;
    activeUserSet.add(record.userId);

    for (const model of record.models) {
      byModel[model] = (byModel[model] ?? 0) + record.sessions;
    }

    dailyMap.set(
      record.date,
      (dailyMap.get(record.date) ?? 0) + tokens,
    );
  }

  // Build daily data points
  const daily: DataPoint[] = [];
  for (let i = daysBack; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    daily.push({
      date: dateStr,
      value: dailyMap.get(dateStr) ?? 0,
    });
  }

  return {
    period,
    startDate: startDateStr,
    endDate: endDateStr,
    totalTokens,
    totalSessions,
    activeUsers: activeUserSet.size,
    daily,
    byModel,
  };
}

// ============================================
// Top Users
// ============================================

/**
 * Rank users by token usage and return top N.
 */
export function getTopUsers(
  users: Array<{
    userId: string;
    displayName: string;
    githubUsername: string;
    plan: PlanTier;
    lastActiveAt: number;
  }>,
  usageRecords: Array<{
    userId: string;
    tokensIn: number;
    tokensOut: number;
    sessions: number;
  }>,
  limit: number = 10,
): UserUsageStats[] {
  // Aggregate usage per user
  const userUsage = new Map<string, { totalTokens: number; totalSessions: number }>();
  for (const record of usageRecords) {
    const existing = userUsage.get(record.userId) ?? { totalTokens: 0, totalSessions: 0 };
    existing.totalTokens += record.tokensIn + record.tokensOut;
    existing.totalSessions += record.sessions;
    userUsage.set(record.userId, existing);
  }

  // Join with user data and sort
  const stats: UserUsageStats[] = users.map((user) => {
    const usage = userUsage.get(user.userId) ?? { totalTokens: 0, totalSessions: 0 };
    return {
      userId: user.userId,
      displayName: user.displayName,
      githubUsername: user.githubUsername,
      plan: user.plan,
      totalTokens: usage.totalTokens,
      totalSessions: usage.totalSessions,
      lastActiveAt: user.lastActiveAt,
    };
  });

  stats.sort((a, b) => b.totalTokens - a.totalTokens);
  return stats.slice(0, limit);
}

// ============================================
// System Health
// ============================================

/**
 * Calculate system health metrics from session data.
 */
export function calculateSystemHealth(
  sessions: Array<{
    startedAt: number;
    endedAt?: number;
    model: string;
    provider: string;
  }>,
): SystemHealth {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const activeSessions = sessions.filter((s) => s.endedAt === undefined).length;
  const sessionsLastHour = sessions.filter((s) => s.startedAt >= oneHourAgo).length;

  // Error rate: sessions that started but never ended and are older than 2 hours
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const stale = sessions.filter(
    (s) => s.endedAt === undefined && s.startedAt < twoHoursAgo,
  ).length;
  const totalCompleted = sessions.filter((s) => s.endedAt !== undefined).length;
  const errorRate = totalCompleted > 0 ? stale / (totalCompleted + stale) : 0;

  // Model and provider distribution
  const modelDistribution: Record<string, number> = {};
  const providerDistribution: Record<string, number> = {};
  let totalDuration = 0;
  let completedCount = 0;

  for (const session of sessions) {
    modelDistribution[session.model] = (modelDistribution[session.model] ?? 0) + 1;
    providerDistribution[session.provider] = (providerDistribution[session.provider] ?? 0) + 1;

    if (session.endedAt) {
      totalDuration += session.endedAt - session.startedAt;
      completedCount++;
    }
  }

  const avgSessionDuration = completedCount > 0 ? totalDuration / completedCount : 0;

  return {
    activeSessions,
    sessionsLastHour,
    errorRate,
    modelDistribution,
    providerDistribution,
    avgSessionDuration,
  };
}
