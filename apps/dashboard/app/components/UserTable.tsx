"use client";

/**
 * UserTable — Paginated user list for the admin dashboard.
 *
 * Shows users with their plan, usage stats, and last activity.
 */

import Link from "next/link";

interface UserRow {
  _id: string;
  displayName: string;
  email: string;
  githubUsername: string;
  avatar: string;
  plan: "free" | "pro" | "team";
  createdAt: number;
  lastActiveAt: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalSessions: number;
  activeSessionCount: number;
}

interface UserTableProps {
  users: UserRow[];
  totalCount: number;
  hasMore: boolean;
  onLoadMore?: () => void;
  title?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const PLAN_BADGES: Record<string, string> = {
  free: "bg-[var(--8gent-bg-hover)] text-[var(--8gent-text-muted)]",
  pro: "bg-[var(--8gent-accent)]/10 text-[var(--8gent-accent)]",
  team: "bg-[var(--8gent-success)]/10 text-[var(--8gent-success)]",
};

export function UserTable({ users, totalCount, hasMore, onLoadMore, title = "Users" }: UserTableProps) {
  return (
    <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)]">
      <div className="flex items-center justify-between border-b border-[var(--8gent-border)] px-6 py-4">
        <h3 className="text-sm font-medium text-[var(--8gent-text)]">{title}</h3>
        <span className="text-xs text-[var(--8gent-text-muted)]">
          {totalCount} total
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--8gent-border)]">
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                User
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Plan
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Total Tokens
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Sessions
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Active
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Last Active
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-8 text-center text-sm text-[var(--8gent-text-muted)]"
                >
                  No users found
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr
                  key={user._id}
                  className="border-b border-[var(--8gent-border)] transition-colors hover:bg-[var(--8gent-bg-hover)]"
                >
                  <td className="px-6 py-3">
                    <Link
                      href={`/users/${user._id}`}
                      className="flex items-center gap-3 group"
                    >
                      {user.avatar && (
                        <img
                          src={user.avatar}
                          alt=""
                          className="h-8 w-8 rounded-full"
                        />
                      )}
                      <div>
                        <div className="text-sm text-[var(--8gent-text)] group-hover:text-[var(--8gent-accent)]">
                          {user.displayName}
                        </div>
                        <div className="text-xs text-[var(--8gent-text-muted)]">
                          @{user.githubUsername}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_BADGES[user.plan]}`}
                    >
                      {user.plan}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                    {formatTokens(user.totalTokensIn + user.totalTokensOut)}
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                    {user.totalSessions}
                  </td>
                  <td className="px-6 py-3">
                    {user.activeSessionCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--8gent-success)]">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--8gent-success)] animate-pulse" />
                        {user.activeSessionCount}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--8gent-text-muted)]">-</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-muted)]">
                    {formatRelativeTime(user.lastActiveAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasMore && onLoadMore && (
        <div className="border-t border-[var(--8gent-border)] px-6 py-3 text-center">
          <button
            onClick={onLoadMore}
            className="text-sm text-[var(--8gent-accent)] hover:text-[var(--8gent-accent-hover)] transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * UserTableSkeleton — Loading placeholder.
 */
export function UserTableSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] animate-pulse">
      <div className="border-b border-[var(--8gent-border)] px-6 py-4">
        <div className="h-4 w-24 rounded bg-[var(--8gent-bg-hover)]" />
      </div>
      <div className="p-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-[var(--8gent-bg-hover)]" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-32 rounded bg-[var(--8gent-bg-hover)]" />
              <div className="h-3 w-20 rounded bg-[var(--8gent-bg-hover)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
