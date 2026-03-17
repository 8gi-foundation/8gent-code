"use client";

/**
 * SessionTable — Recent sessions table for the admin dashboard.
 *
 * Shows sessions across all users with model, duration, tokens, and status.
 */

interface SessionRow {
  _id: string;
  startedAt: number;
  endedAt?: number;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  userDisplayName: string;
  userGithubUsername: string;
  userAvatar: string;
}

interface SessionTableProps {
  sessions: SessionRow[];
  title?: string;
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SessionTable({ sessions, title = "Recent Sessions" }: SessionTableProps) {
  return (
    <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)]">
      <div className="border-b border-[var(--8gent-border)] px-6 py-4">
        <h3 className="text-sm font-medium text-[var(--8gent-text)]">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--8gent-border)]">
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                User
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Model
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Duration
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Tokens
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Tools
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-[var(--8gent-text-muted)] uppercase tracking-wider">
                Started
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-8 text-center text-sm text-[var(--8gent-text-muted)]"
                >
                  No sessions found
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr
                  key={session._id}
                  className="border-b border-[var(--8gent-border)] transition-colors hover:bg-[var(--8gent-bg-hover)]"
                >
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      {session.userAvatar && (
                        <img
                          src={session.userAvatar}
                          alt=""
                          className="h-6 w-6 rounded-full"
                        />
                      )}
                      <span className="text-sm text-[var(--8gent-text)]">
                        {session.userDisplayName}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <span className="rounded bg-[var(--8gent-bg-hover)] px-2 py-0.5 text-xs text-[var(--8gent-accent)]">
                      {session.model}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                    {formatDuration(session.startedAt, session.endedAt)}
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                    {formatTokens(session.tokensIn + session.tokensOut)}
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-secondary)]">
                    {session.toolCalls}
                  </td>
                  <td className="px-6 py-3">
                    {session.endedAt === undefined ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--8gent-success)]/10 px-2 py-0.5 text-xs text-[var(--8gent-success)]">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--8gent-success)] animate-pulse" />
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--8gent-bg-hover)] px-2 py-0.5 text-xs text-[var(--8gent-text-muted)]">
                        Ended
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-[var(--8gent-text-muted)]">
                    {formatTimestamp(session.startedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * SessionTableSkeleton — Loading placeholder.
 */
export function SessionTableSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] animate-pulse">
      <div className="border-b border-[var(--8gent-border)] px-6 py-4">
        <div className="h-4 w-32 rounded bg-[var(--8gent-bg-hover)]" />
      </div>
      <div className="p-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-[var(--8gent-bg-hover)]" />
        ))}
      </div>
    </div>
  );
}
