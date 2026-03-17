"use client";

/**
 * Admin Dashboard — Main Page
 *
 * Shows high-level platform stats, usage charts, recent sessions,
 * and model distribution. All data comes from Convex admin queries.
 */

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { StatsCard, StatsCardSkeleton } from "./components/StatsCard";
import { UsageChart, UsageChartSkeleton } from "./components/UsageChart";
import { SessionTable, SessionTableSkeleton } from "./components/SessionTable";
import { PLAN_DEFINITIONS } from "@8gent/control-plane";

export default function DashboardPage() {
  const dashboard = useQuery(api.admin.getAdminDashboard);
  const timeseries = useQuery(api.admin.getUsageTimeseries, { days: 30 });
  const recentSessions = useQuery(api.admin.getRecentSessions, { limit: 20 });
  const health = useQuery(api.admin.getSystemHealth);

  const isLoading = !dashboard || !timeseries || !recentSessions || !health;

  // Calculate estimated revenue from plan distribution
  const estimatedRevenue = dashboard
    ? Object.entries(dashboard.planDistribution).reduce((sum, [tier, count]) => {
        const plan = PLAN_DEFINITIONS[tier as keyof typeof PLAN_DEFINITIONS];
        return sum + (plan?.priceMonthly ?? 0) * count;
      }, 0)
    : 0;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)]">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-[var(--8gent-text)]">
                8gent Dashboard
              </h1>
              <p className="text-xs text-[var(--8gent-text-muted)]">
                Admin Control Plane
              </p>
            </div>
            <nav className="flex gap-4">
              <a
                href="/"
                className="text-sm text-[var(--8gent-accent)] border-b-2 border-[var(--8gent-accent)] pb-1"
              >
                Overview
              </a>
              <a
                href="/users"
                className="text-sm text-[var(--8gent-text-muted)] hover:text-[var(--8gent-text-secondary)] transition-colors pb-1"
              >
                Users
              </a>
            </nav>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <StatsCardSkeleton key={i} />)
          ) : (
            <>
              <StatsCard
                value={dashboard.userCount}
                label="Total Users"
                icon="U"
              />
              <StatsCard
                value={dashboard.activeSessionCount}
                label="Active Sessions"
                icon="S"
              />
              <StatsCard
                value={formatTokenCount(dashboard.tokensToday)}
                label="Tokens Today"
                icon="T"
              />
              <StatsCard
                value={`$${(estimatedRevenue / 100).toFixed(0)}/mo`}
                label="Est. Revenue"
                icon="$"
              />
            </>
          )}
        </div>

        {/* Usage Chart */}
        {isLoading ? (
          <UsageChartSkeleton />
        ) : (
          <UsageChart data={timeseries} />
        )}

        {/* Two-column layout: Sessions + Health */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Recent Sessions (2/3 width) */}
          <div className="lg:col-span-2">
            {isLoading ? (
              <SessionTableSkeleton />
            ) : (
              <SessionTable sessions={recentSessions} />
            )}
          </div>

          {/* System Health (1/3 width) */}
          <div className="space-y-4">
            {/* Health Card */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                System Health
              </h3>
              {isLoading ? (
                <div className="space-y-3 animate-pulse">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-6 rounded bg-[var(--8gent-bg-hover)]" />
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <HealthRow
                    label="Active Sessions"
                    value={String(health.activeSessions)}
                  />
                  <HealthRow
                    label="Sessions (1hr)"
                    value={String(health.sessionsLastHour)}
                  />
                  <HealthRow
                    label="Error Rate"
                    value={`${(health.errorRate * 100).toFixed(2)}%`}
                    status={health.errorRate > 0.05 ? "error" : health.errorRate > 0.01 ? "warning" : "success"}
                  />
                  <HealthRow
                    label="Avg Duration"
                    value={formatDuration(health.avgSessionDuration)}
                  />
                  <HealthRow
                    label="Stale Sessions"
                    value={String(health.staleSessions)}
                    status={health.staleSessions > 5 ? "error" : health.staleSessions > 0 ? "warning" : "success"}
                  />
                </div>
              )}
            </div>

            {/* Model Distribution */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                Model Distribution
              </h3>
              {isLoading ? (
                <div className="space-y-2 animate-pulse">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-6 rounded bg-[var(--8gent-bg-hover)]" />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(health.modelDistribution)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 8)
                    .map(([model, count]) => {
                      const total = Object.values(health.modelDistribution).reduce(
                        (s, v) => s + v,
                        0,
                      );
                      const pct = total > 0 ? (count / total) * 100 : 0;
                      return (
                        <div key={model}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-[var(--8gent-text-secondary)] truncate max-w-[140px]">
                              {model}
                            </span>
                            <span className="text-[var(--8gent-text-muted)]">
                              {count} ({pct.toFixed(0)}%)
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--8gent-bg-hover)]">
                            <div
                              className="h-1.5 rounded-full bg-[var(--8gent-accent)]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  {Object.keys(health.modelDistribution).length === 0 && (
                    <p className="text-xs text-[var(--8gent-text-muted)]">No data yet</p>
                  )}
                </div>
              )}
            </div>

            {/* Plan Distribution */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                Plan Distribution
              </h3>
              {isLoading ? (
                <div className="space-y-2 animate-pulse">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-6 rounded bg-[var(--8gent-bg-hover)]" />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(dashboard.planDistribution).map(([plan, count]) => (
                    <div key={plan} className="flex items-center justify-between text-sm">
                      <span className="text-[var(--8gent-text-secondary)] capitalize">
                        {plan}
                      </span>
                      <span className="text-[var(--8gent-text)]">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================
// Helper Components
// ============================================

function HealthRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: "success" | "warning" | "error";
}) {
  const statusColors = {
    success: "text-[var(--8gent-success)]",
    warning: "text-[var(--8gent-warning)]",
    error: "text-[var(--8gent-error)]",
  };

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--8gent-text-muted)]">{label}</span>
      <span
        className={`text-sm font-medium ${status ? statusColors[status] : "text-[var(--8gent-text)]"}`}
      >
        {value}
      </span>
    </div>
  );
}

// ============================================
// Formatting Helpers
// ============================================

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms === 0) return "N/A";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
