"use client";

/**
 * User Management Page
 *
 * Paginated user list with search, plan filtering, and click-through
 * to user detail pages.
 */

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { UserTable, UserTableSkeleton } from "../components/UserTable";

type PlanFilter = "free" | "pro" | "team" | undefined;

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanFilter>(undefined);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const result = useQuery(api.admin.getUserList, {
    limit,
    offset,
    search: search || undefined,
    planFilter,
  });

  const isLoading = !result;

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

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
        {/* Search and Filter Bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium text-[var(--8gent-text)]">Users</h2>
            {result && (
              <span className="rounded-full bg-[var(--8gent-bg-hover)] px-2 py-0.5 text-xs text-[var(--8gent-text-muted)]">
                {result.totalCount}
              </span>
            )}
          </div>
          <div className="flex gap-3">
            {/* Search Input */}
            <input
              type="text"
              placeholder="Search users..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              className="rounded-md border border-[var(--8gent-border)] bg-[var(--8gent-bg)] px-3 py-1.5 text-sm text-[var(--8gent-text)] placeholder:text-[var(--8gent-text-muted)] focus:border-[var(--8gent-border-focus)] focus:outline-none"
            />

            {/* Plan Filter */}
            <select
              value={planFilter ?? "all"}
              onChange={(e) => {
                const val = e.target.value;
                setPlanFilter(val === "all" ? undefined : (val as PlanFilter));
                setOffset(0);
              }}
              className="rounded-md border border-[var(--8gent-border)] bg-[var(--8gent-bg)] px-3 py-1.5 text-sm text-[var(--8gent-text)] focus:border-[var(--8gent-border-focus)] focus:outline-none"
            >
              <option value="all">All plans</option>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="team">Team</option>
            </select>
          </div>
        </div>

        {/* User Table */}
        {isLoading ? (
          <UserTableSkeleton />
        ) : (
          <>
            <UserTable
              users={result.users}
              totalCount={result.totalCount}
              hasMore={result.hasMore}
              onLoadMore={() => setOffset((prev) => prev + limit)}
            />

            {/* Pagination */}
            {result.totalCount > limit && (
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
                  disabled={offset === 0}
                  className="rounded-md border border-[var(--8gent-border)] px-3 py-1.5 text-sm text-[var(--8gent-text-secondary)] hover:bg-[var(--8gent-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <span className="text-xs text-[var(--8gent-text-muted)]">
                  Showing {offset + 1}-{Math.min(offset + limit, result.totalCount)} of{" "}
                  {result.totalCount}
                </span>
                <button
                  onClick={() => setOffset((prev) => prev + limit)}
                  disabled={!result.hasMore}
                  className="rounded-md border border-[var(--8gent-border)] px-3 py-1.5 text-sm text-[var(--8gent-text-secondary)] hover:bg-[var(--8gent-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
