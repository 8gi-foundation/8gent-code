"use client";

/**
 * User Detail Page
 *
 * Shows a single user's profile, session history, usage charts,
 * preferences, and plan management.
 */

import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";

export default function UserDetailPage() {
  const params = useParams();
  const userId = params.id as string;

  const detail = useQuery(api.admin.getUserDetail, {
    userId: userId as Id<"users">,
  });
  const updatePlan = useMutation(api.users.updatePlan);

  const [planUpdating, setPlanUpdating] = useState(false);

  if (!detail) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-7xl px-6 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-32 rounded-lg bg-[var(--8gent-bg-elevated)]" />
            <div className="h-64 rounded-lg bg-[var(--8gent-bg-elevated)]" />
            <div className="h-48 rounded-lg bg-[var(--8gent-bg-elevated)]" />
          </div>
        </main>
      </div>
    );
  }

  if (!detail.user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-7xl px-6 py-8">
          <div className="rounded-lg border border-[var(--8gent-error)]/30 bg-[var(--8gent-bg-elevated)] p-8 text-center">
            <p className="text-[var(--8gent-error)]">User not found</p>
            <a href="/users" className="mt-2 inline-block text-sm text-[var(--8gent-accent)]">
              Back to users
            </a>
          </div>
        </main>
      </div>
    );
  }

  const { user, sessions, usageRecords, preferences, stats } = detail;

  async function handlePlanChange(newPlan: "free" | "pro" | "team") {
    setPlanUpdating(true);
    try {
      await updatePlan({ clerkId: user.clerkId, plan: newPlan });
    } finally {
      setPlanUpdating(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
        {/* Breadcrumb */}
        <div className="text-sm text-[var(--8gent-text-muted)]">
          <a href="/users" className="hover:text-[var(--8gent-accent)] transition-colors">
            Users
          </a>
          <span className="mx-2">/</span>
          <span className="text-[var(--8gent-text)]">{user.displayName}</span>
        </div>

        {/* Profile Card */}
        <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
          <div className="flex items-start gap-6">
            {user.avatar && (
              <img
                src={user.avatar}
                alt=""
                className="h-16 w-16 rounded-full"
              />
            )}
            <div className="flex-1">
              <h2 className="text-xl font-bold text-[var(--8gent-text)]">
                {user.displayName}
              </h2>
              <p className="text-sm text-[var(--8gent-text-muted)]">@{user.githubUsername}</p>
              <p className="text-sm text-[var(--8gent-text-secondary)]">{user.email}</p>
              <p className="mt-1 text-xs text-[var(--8gent-text-muted)]">
                Joined {new Date(user.createdAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            </div>

            {/* Plan Management */}
            <div className="text-right">
              <label className="text-xs text-[var(--8gent-text-muted)]">Plan</label>
              <select
                value={user.plan}
                onChange={(e) => handlePlanChange(e.target.value as "free" | "pro" | "team")}
                disabled={planUpdating}
                className="mt-1 block rounded-md border border-[var(--8gent-border)] bg-[var(--8gent-bg)] px-3 py-1.5 text-sm text-[var(--8gent-text)] focus:border-[var(--8gent-border-focus)] focus:outline-none disabled:opacity-50"
              >
                <option value="free">Free</option>
                <option value="pro">Pro ($29/mo)</option>
                <option value="team">Team ($99/mo)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatBox
            label="Total Tokens In"
            value={formatTokenCount(stats.totalTokensIn)}
          />
          <StatBox
            label="Total Tokens Out"
            value={formatTokenCount(stats.totalTokensOut)}
          />
          <StatBox
            label="Total Sessions"
            value={String(stats.totalSessions)}
          />
          <StatBox
            label="Active Sessions"
            value={String(stats.activeSessions)}
            highlight={stats.activeSessions > 0}
          />
        </div>

        {/* Two-column: Sessions + Sidebar */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Session History */}
          <div className="lg:col-span-2 rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)]">
            <div className="border-b border-[var(--8gent-border)] px-6 py-4">
              <h3 className="text-sm font-medium text-[var(--8gent-text)]">
                Session History
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--8gent-border)]">
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Model
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Provider
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Tokens
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Tools
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Duration
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase">
                      Started
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-8 text-center text-sm text-[var(--8gent-text-muted)]"
                      >
                        No sessions yet
                      </td>
                    </tr>
                  ) : (
                    sessions.map((session) => (
                      <tr
                        key={session._id}
                        className="border-b border-[var(--8gent-border)] hover:bg-[var(--8gent-bg-hover)] transition-colors"
                      >
                        <td className="px-6 py-3">
                          <span className="rounded bg-[var(--8gent-bg-hover)] px-2 py-0.5 text-xs text-[var(--8gent-accent)]">
                            {session.model}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                          {session.provider}
                        </td>
                        <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                          {formatTokenCount(session.tokensIn + session.tokensOut)}
                        </td>
                        <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                          {session.toolCalls}
                        </td>
                        <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                          {formatDuration(session.startedAt, session.endedAt)}
                        </td>
                        <td className="px-6 py-3 text-sm text-[var(--8gent-text-muted)]">
                          {new Date(session.startedAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sidebar: Preferences + Usage + Models */}
          <div className="space-y-4">
            {/* Preferences */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                Preferences
              </h3>
              {preferences ? (
                <div className="space-y-2">
                  <PrefRow label="Default Model" value={preferences.defaultModel || "None"} />
                  <PrefRow label="Provider" value={preferences.defaultProvider} />
                  <PrefRow label="Theme" value={preferences.theme} />
                  <PrefRow label="LoRA Status" value={preferences.loraStatus} />
                  {preferences.loraVersion && (
                    <PrefRow label="LoRA Version" value={preferences.loraVersion} />
                  )}
                </div>
              ) : (
                <p className="text-xs text-[var(--8gent-text-muted)]">No preferences set</p>
              )}
            </div>

            {/* Usage Summary */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                Usage Summary
              </h3>
              <div className="space-y-2">
                {usageRecords.slice(-7).map((record) => (
                  <div key={record._id} className="flex items-center justify-between text-xs">
                    <span className="text-[var(--8gent-text-muted)]">{record.date}</span>
                    <span className="text-[var(--8gent-text-secondary)]">
                      {formatTokenCount(record.tokensIn + record.tokensOut)} tokens
                    </span>
                  </div>
                ))}
                {usageRecords.length === 0 && (
                  <p className="text-xs text-[var(--8gent-text-muted)]">No usage data</p>
                )}
              </div>
            </div>

            {/* Models Used */}
            <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
              <h3 className="mb-4 text-sm font-medium text-[var(--8gent-text)]">
                Models Used
              </h3>
              <div className="flex flex-wrap gap-1">
                {stats.uniqueModels.length > 0 ? (
                  stats.uniqueModels.map((model) => (
                    <span
                      key={model}
                      className="rounded bg-[var(--8gent-bg-hover)] px-2 py-0.5 text-xs text-[var(--8gent-accent)]"
                    >
                      {model}
                    </span>
                  ))
                ) : (
                  <p className="text-xs text-[var(--8gent-text-muted)]">No models used</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================
// Sub-components
// ============================================

function Header() {
  return (
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
              className="text-sm text-[var(--8gent-text-muted)] hover:text-[var(--8gent-text-secondary)] transition-colors pb-1"
            >
              Overview
            </a>
            <a
              href="/users"
              className="text-sm text-[var(--8gent-accent)] border-b-2 border-[var(--8gent-accent)] pb-1"
            >
              Users
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}

function StatBox({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-4">
      <div className="text-xs text-[var(--8gent-text-muted)]">{label}</div>
      <div
        className={`mt-1 text-xl font-bold ${highlight ? "text-[var(--8gent-success)]" : "text-[var(--8gent-text)]"}`}
      >
        {value}
      </div>
    </div>
  );
}

function PrefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-[var(--8gent-text-muted)]">{label}</span>
      <span className="text-[var(--8gent-text-secondary)]">{value}</span>
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

function formatDuration(startedAt: number, endedAt?: number): string {
  const end = endedAt ?? Date.now();
  const durationMs = end - startedAt;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
